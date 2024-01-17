import * as Viewer from '../viewer.js';
import { SceneContext } from '../SceneBase.js';
import { rust } from '../rustlib.js';
import { WowM2, WowSkin, WowBlp, WowPixelFormat, WowWdt, WowAdt, WowAdtChunkDescriptor, WowDoodad } from '../../rust/pkg/index.js';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper.js';
import { DeviceProgram } from '../Program.js';
import { GfxDevice, GfxVertexAttributeDescriptor, GfxInputLayoutBufferDescriptor, GfxVertexBufferFrequency, GfxBufferUsage, GfxVertexBufferDescriptor, GfxBindingLayoutDescriptor, GfxCullMode, GfxIndexBufferDescriptor, makeTextureDescriptor2D, GfxMipFilterMode, GfxTexFilterMode, GfxWrapMode, GfxTextureDimension, GfxTextureUsage, GfxInputLayoutDescriptor } from '../gfx/platform/GfxPlatform.js';
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

const terrainBindingLayouts: GfxBindingLayoutDescriptor[] = [
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
    gl_Position = Mul(u_Projection, Mul(u_ModelView, vec4(a_Position, 1.0)));
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

const modelBindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 2, numSamplers: 4 }, // ub_SceneParams
];

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

layout(std140) uniform ub_ModelParams {
    Mat4x4 u_Transform;
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
    gl_Position = Mul(u_Projection, Mul(u_ModelView, Mul(u_Transform, vec4(a_Position, 1.0))));
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

type Constructor<T> = (data: Uint8Array) => T;

// FIXME this is a memory leak
let _fileCache: Map<number, any> = new Map();
async function fetchFileByID<T>(fileId: number, dataFetcher: DataFetcher, constructor: Constructor<T>): Promise<T> {
  if (_fileCache.has(fileId)) {
    return _fileCache.get(fileId);
  }
  const buf = await fetchDataByFileID(fileId, dataFetcher);
  const file = constructor(buf);
  _fileCache.set(fileId, file);
  return file;
}

let _fetchedIds: {[key: number]: number} = {};
async function fetchDataByFileID(fileId: number, dataFetcher: DataFetcher): Promise<Uint8Array> {
  if (fileId in _fetchedIds) {
    console.log(`dupe fetch (${_fetchedIds[fileId]} ${getFilePath(fileId)})`)
    _fetchedIds[fileId]++;
  } else {
    _fetchedIds[fileId] = 1;
  }
  const filePath = getFilePath(fileId);
  const buf = await dataFetcher.fetchData(`/wow/${filePath}`);
  return buf.createTypedArray(Uint8Array);
}

class ModelRenderer {
  public m2: WowM2;
  public skins: WowSkin[] = [];
  public blps: WowBlp[] = [];
  public blpIds: number[] = [];

  private vertexBuffer: GfxVertexBufferDescriptor;
  private indexBuffer: GfxIndexBufferDescriptor;
  private inputLayout: GfxInputLayout;

  static async create(fileId: number, device: GfxDevice, renderHelper: GfxRenderHelper, dataFetcher: DataFetcher): Promise<ModelRenderer> {
    const model = new ModelRenderer(fileId, renderHelper);
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
    this.m2 = await fetchFileByID(this.fileId, dataFetcher, rust.WowM2.new);
    for (let txid of this.m2.texture_ids) {
      const blp = await fetchFileByID(txid, dataFetcher, rust.WowBlp.new);
      this.blpIds.push(txid);
      this.blps.push(blp);
    }

    for (let skid of this.m2.skin_ids) {
      const skin = await fetchFileByID(skid, dataFetcher, rust.WowSkin.new);
      this.skins.push(skin);
    }

    this.vertexBuffer = {
      buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, this.m2.get_vertex_data().buffer),
      byteOffset: 0,
    };
    // FIXME: handle multiple skins
    let skinIndices = this.skins[0].get_indices();
    this.indexBuffer = {
      buffer: makeStaticDataBuffer(device, GfxBufferUsage.Index, skinIndices.buffer),
      byteOffset: 0,
    };
  }

  public setOnRenderInst(renderInst: GfxRenderInst, textureCache: TextureCache): void {
    const skin = this.skins[0];
    const textureLookupTable = this.m2.get_texture_lookup_table();
    for (let batch of skin.batches) {
      const submesh = skin.submeshes[batch.skin_submesh_index];
      renderInst.setVertexInput(this.inputLayout, [this.vertexBuffer], this.indexBuffer);
      renderInst.drawIndexes(submesh.index_count, submesh.index_start);
      const m2TextureIndex = textureLookupTable[batch.texture_combo_index]; // FIXME handle more than 1 batch texture
      const blp = this.blps[m2TextureIndex];
      const blpId = this.blpIds[m2TextureIndex];
      const mapping = textureCache.getTextureMapping(blpId, blp);
      renderInst.setSamplerBindingsFromTextureMappings([mapping]);
    }
  }
  
  public destroy(device: GfxDevice): void {
    device.destroyBuffer(this.vertexBuffer.buffer);
    device.destroyBuffer(this.indexBuffer.buffer);
  }
}

class Adt {
  public blps: Map<number, WowBlp>;
  public models: Map<number, ModelRenderer>;

  constructor(public innerAdt: WowAdt) {
    this.blps = new Map();
    this.models = new Map();
  }
  
  public async load(dataFetcher: DataFetcher, device: GfxDevice, renderHelper: GfxRenderHelper) {
      const blpIds = this.innerAdt.get_texture_file_ids();
      for (let blpId of blpIds) {
        const blp = await fetchFileByID(blpId, dataFetcher, rust.WowBlp.new);
        this.blps.set(blpId, blp);
      }

      const modelIds = this.innerAdt.get_model_file_ids();
      for (let modelId of modelIds) {
        this.models.set(modelId, await ModelRenderer.create(modelId, device, renderHelper, dataFetcher));
      }
  }

  public getBufsAndChunks(device: GfxDevice): [GfxVertexBufferDescriptor, GfxIndexBufferDescriptor, WowAdtChunkDescriptor[]] {
    const renderResult = this.innerAdt.get_render_result();
    const vertexBuffer = {
      buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, renderResult.vertex_buffer.buffer),
      byteOffset: 0,
    };
    const indexBuffer = {
      buffer: makeStaticDataBuffer(device, GfxBufferUsage.Index, renderResult.index_buffer.buffer),
      byteOffset: 0,
    };
    const adtChunks = renderResult.chunks;
    return [vertexBuffer, indexBuffer, adtChunks];
  }
}

class AdtModelRenderer {
  public doodads: WowDoodad[] = [];
  public modelsToDoodads: Map<ModelRenderer, WowDoodad[]>;

  constructor(device: GfxDevice, private textureCache: TextureCache, public adt: Adt) {
    this.modelsToDoodads = this.sortDoodadsByModels(adt.innerAdt.doodads);
  }

  private sortDoodadsByModels(doodads: WowDoodad[]): Map<ModelRenderer, WowDoodad[]> {
    const map = new Map();
    for (let doodad of doodads) {
      let model = this.adt.models.get(doodad.name_id);
      if (!model) {
        throw new Error(`couldn't find model with fileId ${doodad.name_id}`);
      }
      if (map.has(model)) {
        map.get(model).push(doodad);
      } else {
        map.set(model, [doodad]);
      }
    }
    return map;
  }

  private getDoodadTranformMat(doodad: WowDoodad): mat4 {
    const scale = doodad.scale / 1024;
    const rotation = mat4.create();
    mat4.identity(rotation);
    mat4.rotateX(rotation, rotation, doodad.rotation.x);
    mat4.rotateY(rotation, rotation, doodad.rotation.y);
    mat4.rotateZ(rotation, rotation, doodad.rotation.z);
    const doodadMat = mat4.create();
    mat4.fromRotationTranslationScale(
      doodadMat,
      rotation,
      [doodad.position.x - 17066, doodad.position.y, doodad.position.z - 17066],
      [scale, scale, scale]
    );
    return doodadMat;
  }

  public prepareToRender(renderInstManager: GfxRenderInstManager): void {
    for (let [model, doodads] of this.modelsToDoodads) {
      const template = renderInstManager.pushTemplateRenderInst();
      model.setOnRenderInst(template, this.textureCache);
      for (let doodad of doodads) {
        const renderInst = renderInstManager.newRenderInst();
        let offs = renderInst.allocateUniformBuffer(ModelProgram.ub_ModelParams, 16);
        const mapped = renderInst.mapUniformBufferF32(ModelProgram.ub_ModelParams);
        offs += fillMatrix4x4(mapped, offs, this.getDoodadTranformMat(doodad));
        renderInstManager.submitRenderInst(renderInst);
      }
      renderInstManager.popTemplateRenderInst();
    }
  }

  public destroy(device: GfxDevice): void {
  }
}

class AdtTerrainRenderer {
  private inputLayout: GfxInputLayout;
  public indexBuffer: GfxIndexBufferDescriptor;
  public vertexBuffer: GfxVertexBufferDescriptor;
  public adtChunks: WowAdtChunkDescriptor[] = [];

  constructor(device: GfxDevice, renderHelper: GfxRenderHelper, public adt: Adt, private textureCache: TextureCache) {
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
    [this.vertexBuffer, this.indexBuffer, this.adtChunks] = this.adt.getBufsAndChunks(device);
  }

  private getChunkTextureMapping(chunk: WowAdtChunkDescriptor): (TextureMapping | null)[] {
    let mapping: (TextureMapping | null)[] = [null, null, null, null];
    chunk.texture_layers.forEach((textureFileId, i) => {
      const blp = this.adt.blps.get(textureFileId);
      if (!blp) {
        throw new Error(`couldn't find matching blp for fileID ${textureFileId}`);
      }
      mapping[i] = this.textureCache.getTextureMapping(textureFileId, blp);
    })
    return mapping;
  }

  public prepareToRender(renderInstManager: GfxRenderInstManager) {
    const template = renderInstManager.pushTemplateRenderInst();
    template.setVertexInput(this.inputLayout, [this.vertexBuffer], this.indexBuffer);
    this.adtChunks.forEach(chunk => {
      const renderInst = renderInstManager.newRenderInst();
      const textureMapping = this.getChunkTextureMapping(chunk);
      renderInst.setSamplerBindingsFromTextureMappings(textureMapping);
      renderInst.drawIndexes(chunk.index_count, chunk.index_offset);
      renderInstManager.submitRenderInst(renderInst);
    })
    renderInstManager.popTemplateRenderInst();
  }

  public destroy(device: GfxDevice) {
    device.destroyBuffer(this.vertexBuffer.buffer);
    device.destroyBuffer(this.indexBuffer.buffer);
  }
}

class WorldScene implements Viewer.SceneGfx {
  private terrainRenderers: AdtTerrainRenderer[] = [];
  private modelRenderers: AdtModelRenderer[] = [];
  private terrainProgram: GfxProgram;
  private modelProgram: GfxProgram;

  constructor(device: GfxDevice, public world: World, public textureHolder: DebugTexHolder, public renderHelper: GfxRenderHelper) {
    const textureCache = new TextureCache(this.renderHelper.renderCache);
    this.terrainProgram = this.renderHelper.renderCache.createProgram(new TerrainProgram());
    this.modelProgram = this.renderHelper.renderCache.createProgram(new ModelProgram());

    for (let adt of this.world.adts) {
      this.terrainRenderers.push(new AdtTerrainRenderer(device, this.renderHelper, adt, textureCache));
      this.modelRenderers.push(new AdtModelRenderer(device, textureCache, adt));
    }
  }

  private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
    const template = this.renderHelper.pushTemplateRenderInst();
    template.setBindingLayouts(terrainBindingLayouts);
    template.setGfxProgram(this.terrainProgram);
    template.setMegaStateFlags({ cullMode: GfxCullMode.Back });

    let offs = template.allocateUniformBuffer(ModelProgram.ub_SceneParams, 32);
    const mapped = template.mapUniformBufferF32(ModelProgram.ub_SceneParams);
    offs += fillMatrix4x4(mapped, offs, viewerInput.camera.projectionMatrix);
    const viewMat = mat4.create();
    mat4.mul(viewMat, viewerInput.camera.viewMatrix, noclipSpaceFromWowSpace);
    offs += fillMatrix4x4(mapped, offs, viewMat);

    this.terrainRenderers.forEach(terrainRenderer => {
      terrainRenderer.prepareToRender(this.renderHelper.renderInstManager);
    });

    template.setBindingLayouts(modelBindingLayouts);
    template.setGfxProgram(this.modelProgram);
    this.modelRenderers.forEach(modelRenderer => {
      modelRenderer.prepareToRender(this.renderHelper.renderInstManager);
    });

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
    this.terrainRenderers.forEach(terrainRenderer => {
      terrainRenderer.destroy(device);
    });
  }
}

class World {
  public wdt: WowWdt;
  public adts: Adt[] = [];

  constructor(public fileId: number) {
  }

  public async load(dataFetcher: DataFetcher, device: GfxDevice, renderHelper: GfxRenderHelper) {
    this.wdt = await fetchFileByID(this.fileId, dataFetcher, rust.WowWdt.new);
    for (let fileIDs of this.wdt.get_loaded_map_data()) {
      if (fileIDs.root_adt === 0) {
        console.log('null ADTs?')
        continue;
      }
      // TODO handle obj1 (LOD) adts
      const wowAdt = rust.WowAdt.new(await fetchDataByFileID(fileIDs.root_adt, dataFetcher));
      wowAdt.append_obj_adt(await fetchDataByFileID(fileIDs.obj0_adt, dataFetcher));
      wowAdt.append_tex_adt(await fetchDataByFileID(fileIDs.tex0_adt, dataFetcher));

      const adt = new Adt(wowAdt);
      await adt.load(dataFetcher, device, renderHelper);

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
    for (let adt of wdt.adts) {
      for (let [blpId, blp] of adt.blps) {
        const texPath = getFilePath(blpId);
        entries.push({
          name: texPath,
          width: blp.header.width,
          height: blp.header.height,
          blp: blp,
        });
      }
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
