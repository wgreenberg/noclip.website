import * as Viewer from '../viewer.js';
import { SceneContext } from '../SceneBase.js';
import { rust } from '../rustlib.js';
import { WowM2, WowSkin, WowBlp, WowPixelFormat, WowWdt, WowAdt, WowAdtChunkDescriptor } from '../../rust/pkg/index.js';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper.js';
import { DeviceProgram } from '../Program.js';
import { GfxDevice, GfxVertexAttributeDescriptor, GfxInputLayoutBufferDescriptor, GfxVertexBufferFrequency, GfxBufferUsage, GfxVertexBufferDescriptor, GfxBindingLayoutDescriptor, GfxCullMode, GfxIndexBufferDescriptor, makeTextureDescriptor2D, GfxMipFilterMode, GfxTexFilterMode, GfxWrapMode, GfxTextureDimension, GfxTextureUsage } from '../gfx/platform/GfxPlatform.js';
import { GfxFormat } from '../gfx/platform/GfxPlatformFormat.js';
import { GfxBuffer, GfxInputLayout, GfxProgram } from '../gfx/platform/GfxPlatformImpl.js';
import { GfxRenderInst, GfxRenderInstManager } from '../gfx/render/GfxRenderInstManager.js';
import { makeStaticDataBuffer } from '../gfx/helpers/BufferHelpers.js';
import { makeBackbufferDescSimple, standardFullClearRenderPassDescriptor, pushAntialiasingPostProcessPass } from '../gfx/helpers/RenderGraphHelpers.js';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph.js';
import { fillMatrix4x4 } from '../gfx/helpers/UniformBufferHelpers.js';
import { DataFetcher, NamedArrayBufferSlice } from '../DataFetcher.js';
import { nArray } from '../util.js';
import { DebugTex, DebugTexHolder, TextureCache } from './tex.js';
import { TextureMapping } from '../TextureHolder.js';
import { mat4 } from 'gl-matrix';
import { CameraController } from '../Camera.js';
import { TextureListHolder, Panel } from '../ui.js';
import { GfxTopology, convertToTriangleIndexBuffer } from '../gfx/helpers/TopologyHelpers.js';

const id = 'WorldOfWarcaft';
const name = 'World of Warcraft';

const noclipSpaceFromWowSpace = mat4.fromValues(
    1, 0,  0, 0,
    0, 0, -1, 0,
    0, 1,  0, 0,
    0, 0,  0, 1,
);

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 1, numSamplers: 4 }, // ub_SceneParams
];

class TerrainProgram extends DeviceProgram {
  public static a_Position = 0;
  public static a_Normal = 1;
  public static a_Color = 2;

  public static ub_SceneParams = 0;
  public static ub_ModelParams = 1;

  public override both = `
precision mediump float;

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
    Mat4x4 u_ModelView;
};

layout(binding = 0) uniform sampler2D u_Texture0;
layout(binding = 1) uniform sampler2D u_Texture1;
layout(binding = 2) uniform sampler2D u_Texture2;
layout(binding = 3) uniform sampler2D u_Texture3;

varying vec2 v_LightIntensity;
varying vec2 v_UV;
varying vec3 v_Normal;
varying vec4 v_Color;
varying vec3 v_Binormal;
varying vec3 v_Tangent;
varying vec3 v_Position;

#ifdef VERT
layout(location = ${TerrainProgram.a_Position}) attribute vec3 a_Position;
layout(location = ${TerrainProgram.a_Normal}) attribute vec3 a_Normal;
layout(location = ${TerrainProgram.a_Color}) attribute vec4 a_Color;

void mainVS() {
    const float t_ModelScale = 20.0;
    gl_Position = Mul(u_Projection, Mul(u_ModelView, vec4(a_Position * t_ModelScale, 1.0)));
    vec3 t_LightDirection = normalize(vec3(.2, -1, .5));
    v_UV = a_Position.xy;
    v_Color = a_Color;
    float t_LightIntensityF = dot(-a_Normal, t_LightDirection);
    float t_LightIntensityB = dot( a_Normal, t_LightDirection);
    v_LightIntensity = vec2(t_LightIntensityF, t_LightIntensityB);
}
#endif

#ifdef FRAG
void mainPS() {
    float t_LightIntensity = gl_FrontFacing ? v_LightIntensity.x : v_LightIntensity.y;
    float t_LightTint = 0.3 * t_LightIntensity;
    vec4 tex = texture(SAMPLER_2D(u_Texture0), v_UV);
    gl_FragColor = tex + vec4(t_LightTint, t_LightTint, t_LightTint, 0.0);
}
#endif
`;
}

class ModelProgram extends DeviceProgram {
  public static a_Position = 0;
  public static a_Normal = 1;
  public static a_TexCoord = 2;

  public static ub_SceneParams = 0;
  public static ub_ModelParams = 1;

  public override both = `
precision mediump float;

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
    Mat4x4 u_ModelView;
};

layout(binding = 0) uniform sampler2D u_Texture0;

varying vec2 v_LightIntensity;
varying vec2 v_UV;
varying vec3 v_Normal;
varying vec3 v_Binormal;
varying vec3 v_Tangent;
varying vec3 v_Position;

#ifdef VERT
layout(location = ${ModelProgram.a_Position}) attribute vec3 a_Position;
layout(location = ${ModelProgram.a_Normal}) attribute vec3 a_Normal;
layout(location = ${ModelProgram.a_TexCoord}) attribute vec2 a_TexCoord;

void mainVS() {
    const float t_ModelScale = 20.0;
    gl_Position = Mul(u_Projection, Mul(u_ModelView, vec4(a_Position * t_ModelScale, 1.0)));
    vec3 t_LightDirection = normalize(vec3(.2, -1, .5));
    v_UV = a_TexCoord;
    float t_LightIntensityF = dot(-a_Normal, t_LightDirection);
    float t_LightIntensityB = dot( a_Normal, t_LightDirection);
    v_LightIntensity = vec2(t_LightIntensityF, t_LightIntensityB);
}
#endif

#ifdef FRAG
void mainPS() {
    float t_LightIntensity = gl_FrontFacing ? v_LightIntensity.x : v_LightIntensity.y;
    float t_LightTint = 0.3 * t_LightIntensity;
    vec4 tex = texture(SAMPLER_2D(u_Texture0), v_UV);
    gl_FragColor = tex + vec4(t_LightTint, t_LightTint, t_LightTint, 0.0);
}
#endif
`;
}

class ModelRenderer {
  public name: string;
  private textureMapping: (TextureMapping | null)[] = nArray(2, () => null);
  private vertexBuffer: GfxBuffer;
  private indexBufferDescriptor: GfxIndexBufferDescriptor;
  private indexBuffer: GfxBuffer;
  private indexCount: number;
  public vertexBufferDescriptors: GfxVertexBufferDescriptor[];

  constructor(device: GfxDevice, private textureCache: TextureCache, private inputLayout: GfxInputLayout, public model: ModelData) {
    this.name = model.m2.get_name();
    let buf = model.m2.get_vertex_data();
    // FIXME: handle multiple skins
    let skinIndices = model.skins[0].get_indices();
    this.indexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Index, skinIndices.buffer);
    this.indexCount = skinIndices.length;
    this.indexBufferDescriptor = { buffer: this.indexBuffer, byteOffset: 0 };
    this.vertexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, buf.buffer);
    this.vertexBufferDescriptors = [
      { buffer: this.vertexBuffer, byteOffset: 0, },
    ];
  }

  public prepareToRender(renderInstManager: GfxRenderInstManager): void {
    const skin = this.model.skins[0];
    const textureLookupTable = this.model.m2.get_texture_lookup_table();
    for (let batch of skin.batches) {
      const renderInst = renderInstManager.newRenderInst();
      const submesh = skin.submeshes[batch.skin_submesh_index];
      renderInst.setVertexInput(this.inputLayout, this.vertexBufferDescriptors, this.indexBufferDescriptor);
      renderInst.drawIndexes(submesh.index_count, submesh.index_start);
      const m2TextureIndex = textureLookupTable[batch.texture_combo_index]; // FIXME handle more than 1 batch texture
      const blp = this.model.blps[m2TextureIndex];
      const mapping = this.textureCache.getTextureMapping(blp);
      renderInst.setSamplerBindingsFromTextureMappings([mapping]);
      renderInstManager.submitRenderInst(renderInst);
    }
  }

  public destroy(device: GfxDevice): void {
    device.destroyBuffer(this.vertexBuffer);
  }
}

class FileList {
    public files: string[] | undefined;

    constructor() {
    }

    public async load(dataFetcher: DataFetcher) {
      const decoder = new TextDecoder();
      const fileListData = await dataFetcher.fetchData(`wow/listfile.csv`);
      const files: string[] = [];
      decoder.decode(fileListData.createTypedArray(Uint8Array)).split('\r\n').forEach(line => {
        const [idxStr, fileName] = line.split(';');
        const idx = parseInt(idxStr);
        files[idx] = fileName;
      })
      this.files = files;
    }

    public getFilename(fileId: number): string {
      if (!this.files) {
        throw new Error(`must load FileList first`);
      }
      const filePath = this.files[fileId];
      if (!filePath) {
        throw new Error(`couldn't find path for fileId ${fileId}`);
      }
      return filePath;
    }
}

let _fileList: FileList | undefined = undefined;
async function initFileList(dataFetcher: DataFetcher): Promise<undefined> {
  if (!_fileList) {
    _fileList = new FileList();
    await _fileList.load(dataFetcher);
  }
}

function getFilePath(fileId: number): string {
  return _fileList!.getFilename(fileId);
}


async function fetchFileByID(fileId: number, dataFetcher: DataFetcher): Promise<Uint8Array> {
  const filePath = getFilePath(fileId);
  const buf = await dataFetcher.fetchData(`/wow/${filePath}`);
  return buf.createTypedArray(Uint8Array);
}

class ModelData {
  public m2: WowM2;
  public skins: WowSkin[] = [];
  public blps: WowBlp[] = [];

  private vertexBuffer: GfxBuffer;
  private indexBuffer: GfxBuffer;
  private inputLayout: GfxInputLayout;
  private vertexBufferDescriptors: GfxVertexBufferDescriptor[];
  private indexBufferDescriptor: GfxIndexBufferDescriptor;

  static async create(fileId: number, device: GfxDevice, renderHelper: GfxRenderHelper, dataFetcher: DataFetcher): Promise<ModelData> {
    const model = new ModelData(fileId, renderHelper);
    await model.load(dataFetcher, device);
    return model;
  }

  constructor(public fileId: number, renderHelper: GfxRenderHelper) {
    const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
      { location: ModelProgram.a_Position, bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_RGB, },
      { location: ModelProgram.a_Normal,   bufferIndex: 0, bufferByteOffset: 20, format: GfxFormat.F32_RGB, },
      { location: ModelProgram.a_TexCoord, bufferIndex: 0, bufferByteOffset: 32, format: GfxFormat.F32_RG, },
    ];
    const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
      { byteStride: rust.WowM2.get_vertex_stride(), frequency: GfxVertexBufferFrequency.PerVertex, },
    ];
    const indexBufferFormat: GfxFormat = GfxFormat.U16_R;
    this.inputLayout = renderHelper.renderCache.createInputLayout({ vertexAttributeDescriptors, vertexBufferDescriptors, indexBufferFormat });
  }

  public async load(dataFetcher: DataFetcher, device: GfxDevice): Promise<undefined> {
    const m2Data = await fetchFileByID(this.fileId, dataFetcher);
    this.m2 = rust.WowM2.new(m2Data);
    for (let txid of this.m2.get_texture_ids()) {
      const texData = await fetchFileByID(txid, dataFetcher);
      const blp = rust.WowBlp.new(txid, texData);
      this.blps.push(blp);
    }

    for (let skid of this.m2.get_skin_ids()) {
      const skinData = await fetchFileByID(skid, dataFetcher);
      const skin = rust.WowSkin.new(skinData);
      this.skins.push(skin);
    }

    this.vertexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, this.m2.get_vertex_data().buffer);
    // FIXME: handle multiple skins
    let skinIndices = this.skins[0].get_indices();
    this.indexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Index, skinIndices.buffer);
  }

  public setOnRenderInst(renderInst: GfxRenderInst, textureCache: TextureCache): void {
    const skin = this.skins[0];
    const textureLookupTable = this.m2.get_texture_lookup_table();
    for (let batch of skin.batches) {
      const submesh = skin.submeshes[batch.skin_submesh_index];
      renderInst.setVertexInput(this.inputLayout, this.vertexBufferDescriptors, this.indexBufferDescriptor);
      renderInst.drawIndexes(submesh.index_count, submesh.index_start);
      const m2TextureIndex = textureLookupTable[batch.texture_combo_index]; // FIXME handle more than 1 batch texture
      const blp = this.blps[m2TextureIndex];
      const mapping = textureCache.getTextureMapping(blp);
      renderInst.setSamplerBindingsFromTextureMappings([mapping]);
    }
  }
  
  public destroy(device: GfxDevice): void {
    device.destroyBuffer(this.vertexBuffer);
    device.destroyBuffer(this.indexBuffer);
  }
}

class TerrainRenderer {
  private inputLayout: GfxInputLayout;
  public indexBuffers: GfxIndexBufferDescriptor[] = [];
  public vertexBuffers: GfxVertexBufferDescriptor[] = [];
  public adtChunks: WowAdtChunkDescriptor[][] = [];

  constructor(device: GfxDevice, renderHelper: GfxRenderHelper, public world: World, private textureCache: TextureCache) {
    const adtVboInfo = rust.WowAdt.get_vbo_info();
    const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
      { location: TerrainProgram.a_Position, bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_RGB, },
      { location: TerrainProgram.a_Normal,   bufferIndex: 0, bufferByteOffset: adtVboInfo.normal_offset, format: GfxFormat.F32_RGB, },
      { location: TerrainProgram.a_Color, bufferIndex: 0, bufferByteOffset: adtVboInfo.color_offset, format: GfxFormat.F32_RGBA, },
    ];
    const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
      { byteStride: adtVboInfo.stride, frequency: GfxVertexBufferFrequency.PerVertex },
    ];
    const indexBufferFormat: GfxFormat = GfxFormat.U16_R;
    const cache = renderHelper.renderCache;
    this.inputLayout = cache.createInputLayout({ vertexAttributeDescriptors, vertexBufferDescriptors, indexBufferFormat });

    this.world.adts.forEach(adt => {
      const renderResult = adt.get_render_result();
      this.vertexBuffers.push({
        buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, renderResult.vertex_buffer.buffer),
        byteOffset: 0,
      });
      this.indexBuffers.push({
        buffer: makeStaticDataBuffer(device, GfxBufferUsage.Index, renderResult.index_buffer.buffer),
        byteOffset: 0,
      });
      this.adtChunks.push(renderResult.chunks);
    })
  }

  private getChunkTextureMapping(chunk: WowAdtChunkDescriptor): (TextureMapping | null)[] {
    let mapping: (TextureMapping | null)[] = [null, null, null, null];
    chunk.texture_layers.forEach((textureFileId, i) => {
      const blp = this.world.blps.find(blp => blp.file_id == textureFileId);
      if (!blp) {
        throw new Error(`couldn't find matching blp for fileID ${textureFileId}`);
      }
      mapping[i] = this.textureCache.getTextureMapping(blp);
    })
    return mapping;
  }

  public prepareToRender(renderInstManager: GfxRenderInstManager) {
    for (let i=0; i<this.world.adts.length; i++) {
      const template = renderInstManager.pushTemplateRenderInst();
      template.setVertexInput(this.inputLayout, [this.vertexBuffers[i]], this.indexBuffers[i]);
      this.adtChunks[i].forEach(chunk => {
        const renderInst = renderInstManager.newRenderInst();
        const textureMapping = this.getChunkTextureMapping(chunk);
        renderInst.setSamplerBindingsFromTextureMappings(textureMapping);
        renderInst.drawIndexes(chunk.index_count, chunk.index_offset);
        renderInstManager.submitRenderInst(renderInst);
      })
      renderInstManager.popTemplateRenderInst();
    }
  }

  public destroy(device: GfxDevice) {
    for (let i=0; i<this.world.adts.length; i++) {
      device.destroyBuffer(this.vertexBuffers[i].buffer);
      device.destroyBuffer(this.indexBuffers[i].buffer);
    }
  }
}

class WorldScene implements Viewer.SceneGfx {
  private terrainRenderer: TerrainRenderer;
  private program: GfxProgram;

  constructor(device: GfxDevice, public world: World, public textureHolder: DebugTexHolder, public renderHelper: GfxRenderHelper) {
    const textureCache = new TextureCache(this.renderHelper.renderCache);
    this.program = this.renderHelper.renderCache.createProgram(new TerrainProgram());

    this.terrainRenderer = new TerrainRenderer(device, this.renderHelper, this.world, textureCache);
  }

  private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
    const template = this.renderHelper.pushTemplateRenderInst();
    template.setBindingLayouts(bindingLayouts);
    template.setGfxProgram(this.program);
    template.setMegaStateFlags({ cullMode: GfxCullMode.Back });

    let offs = template.allocateUniformBuffer(ModelProgram.ub_SceneParams, 32);
    const mapped = template.mapUniformBufferF32(ModelProgram.ub_SceneParams);
    offs += fillMatrix4x4(mapped, offs, viewerInput.camera.projectionMatrix);
    offs += fillMatrix4x4(mapped, offs, viewerInput.camera.viewMatrix);

    this.terrainRenderer.prepareToRender(this.renderHelper.renderInstManager);

    this.renderHelper.renderInstManager.popTemplateRenderInst();
    this.renderHelper.prepareToRender();
  }

  render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
    const renderInstManager = this.renderHelper.renderInstManager;

    const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, standardFullClearRenderPassDescriptor);
    const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, standardFullClearRenderPassDescriptor);

    const builder = this.renderHelper.renderGraph.newGraphBuilder();

    const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
    const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
    builder.pushPass((pass) => {
      pass.setDebugName('Main');
      pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
      pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
      pass.exec((passRenderer) => {
        renderInstManager.drawOnPassRenderer(passRenderer);
      });
    });
    pushAntialiasingPostProcessPass(builder, this.renderHelper, viewerInput, mainColorTargetID);
    builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

    this.prepareToRender(device, viewerInput);
    this.renderHelper.renderGraph.execute(builder);
    renderInstManager.resetRenderInsts();
  }

  destroy(device: GfxDevice): void {
    this.terrainRenderer.destroy(device);
  }
}

class World {
  public wdt: WowWdt;
  public blps: WowBlp[] = [];
  public adts: WowAdt[] = [];
  public models: ModelData[] = [];

  constructor(public fileId: number) {
  }

  public async load(dataFetcher: DataFetcher, device: GfxDevice, renderHelper: GfxRenderHelper) {
    this.wdt = rust.WowWdt.new(await fetchFileByID(this.fileId, dataFetcher));
    for (let fileIDs of this.wdt.get_loaded_map_data()) {
      if (fileIDs.root_adt === 0) {
        console.log('null ADTs?')
        continue;
      }
      // TODO handle obj1 (LOD) adts
      const adt = rust.WowAdt.new(await fetchFileByID(fileIDs.root_adt, dataFetcher));
      adt.append_obj_adt(await fetchFileByID(fileIDs.obj0_adt, dataFetcher));
      adt.append_tex_adt(await fetchFileByID(fileIDs.tex0_adt, dataFetcher));

      const blpIds = adt.get_texture_file_ids();
      for (let blpId of blpIds) {
        const blp = rust.WowBlp.new(blpId, await fetchFileByID(blpId, dataFetcher));
        this.blps.push(blp);
      }

      const modelIds = adt.get_model_file_ids();
      for (let modelId of modelIds) {
        this.models.push(await ModelData.create(modelId, device, renderHelper, dataFetcher))
      }
      this.adts.push(adt);
    }
  }
}

class WdtSceneDesc implements Viewer.SceneDesc {
  public id: string;

  constructor(public name: string, public fileId: number) {
    this.id = fileId.toString();
  }

  public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
    const dataFetcher = context.dataFetcher;
    const renderHelper = new GfxRenderHelper(device);
    await initFileList(dataFetcher);
    rust.init_panic_hook();
    const wdt = new World(this.fileId);
    console.log('loading wdt')
    await wdt.load(dataFetcher, device, renderHelper);
    console.log('done')
    const holder = new DebugTexHolder();
    let entries: DebugTex[] = [];
    for (let blp of wdt.blps) {
      const texPath = getFilePath(blp.file_id);
      entries.push({
        name: texPath,
        width: blp.header.width,
        height: blp.header.height,
        blp: blp,
      });
    }
    holder.addTextures(device, entries);
    return new WorldScene(device, wdt, holder, renderHelper);
  }
}

const sceneDescs = [
    "Instances",
    new WdtSceneDesc('Zul-Farak', 791169),
    new WdtSceneDesc('Blackrock Depths', 780172),
    new WdtSceneDesc('Alterac Valley', 790112),
    new WdtSceneDesc('pvp 3', 790291),
    new WdtSceneDesc('pvp 4', 790377),
    new WdtSceneDesc('pvp 5', 790469),
    new WdtSceneDesc('Scholomance', 790713),
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs, hidden: false };
