import * as Viewer from '../viewer.js';
import { SceneContext } from '../SceneBase.js';
import { rust } from '../rustlib.js';
import { WowM2, WowSkin, WowBlp, WowPixelFormat, WowWdt, WowAdt } from '../../rust/pkg/index.js';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper.js';
import { DeviceProgram } from '../Program.js';
import { GfxDevice, GfxVertexAttributeDescriptor, GfxInputLayoutBufferDescriptor, GfxVertexBufferFrequency, GfxBufferUsage, GfxVertexBufferDescriptor, GfxBindingLayoutDescriptor, GfxCullMode, GfxIndexBufferDescriptor, makeTextureDescriptor2D, GfxMipFilterMode, GfxTexFilterMode, GfxWrapMode, GfxTextureDimension, GfxTextureUsage } from '../gfx/platform/GfxPlatform.js';
import { GfxFormat } from '../gfx/platform/GfxPlatformFormat.js';
import { GfxBuffer, GfxInputLayout, GfxProgram } from '../gfx/platform/GfxPlatformImpl.js';
import { GfxRenderInstManager } from '../gfx/render/GfxRenderInstManager.js';
import { makeStaticDataBuffer } from '../gfx/helpers/BufferHelpers.js';
import { makeBackbufferDescSimple, standardFullClearRenderPassDescriptor, pushAntialiasingPostProcessPass } from '../gfx/helpers/RenderGraphHelpers.js';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph.js';
import { fillMatrix4x4 } from '../gfx/helpers/UniformBufferHelpers.js';
import { DataFetcher, NamedArrayBufferSlice } from '../DataFetcher.js';
import { nArray } from '../util.js';
import { DebugTex, DebugTexHolder, TextureCache } from './tex.js';
import { TextureMapping } from '../TextureHolder.js';
import { mat4 } from 'gl-matrix';

const id = 'WorldOfWarcaft';
const name = 'World of Warcraft';

const noclipSpaceFromHaloSpace = mat4.fromValues(
    1, 0,  0, 0,
    0, 0, -1, 0,
    0, 1,  0, 0,
    0, 0,  0, 1,
);

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 1, numSamplers: 1 }, // ub_SceneParams
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

  constructor(device: GfxDevice, private textureCache: TextureCache, private inputLayout: GfxInputLayout, public model: WowModel) {
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

class WowModelScene implements Viewer.SceneGfx {
    private renderHelper: GfxRenderHelper;
    private modelRenderers: ModelRenderer[];
    private inputLayout: GfxInputLayout;
    private program: GfxProgram;

    constructor(device: GfxDevice, public model: WowModel, public textureHolder: DebugTexHolder) {
      this.renderHelper = new GfxRenderHelper(device);
      const textureCache = new TextureCache(this.renderHelper.renderCache);
      this.program = this.renderHelper.renderCache.createProgram(new ModelProgram());

      const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
        { location: ModelProgram.a_Position, bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_RGB, },
        { location: ModelProgram.a_Normal,   bufferIndex: 0, bufferByteOffset: 20, format: GfxFormat.F32_RGB, },
        { location: ModelProgram.a_TexCoord, bufferIndex: 0, bufferByteOffset: 32, format: GfxFormat.F32_RG, },
      ];
      const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
        { byteStride: rust.WowM2.get_vertex_stride(), frequency: GfxVertexBufferFrequency.PerVertex, },
      ];
      const indexBufferFormat: GfxFormat = GfxFormat.U16_R;
      const cache = this.renderHelper.renderCache;

      this.inputLayout = cache.createInputLayout({ vertexAttributeDescriptors, vertexBufferDescriptors, indexBufferFormat });
      this.modelRenderers = [new ModelRenderer(device, textureCache, this.inputLayout, this.model)];
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

      for (let i = 0; i < this.modelRenderers.length; i++)
        this.modelRenderers[i].prepareToRender(this.renderHelper.renderInstManager);

      this.renderHelper.renderInstManager.popTemplateRenderInst();
      this.renderHelper.prepareToRender();
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
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
    
    public destroy(device: GfxDevice): void {
      this.modelRenderers.forEach((modelRenderer) => {
        modelRenderer.destroy(device);
      });
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

class WowModel {
  public m2: WowM2;
  public skins: WowSkin[] = [];
  public blps: WowBlp[] = [];

  constructor(public fileId: number) {
    this.skins = [];
    this.blps = [];
  }

  public async load(dataFetcher: DataFetcher): Promise<undefined> {
    const m2Data = await fetchFileByID(this.fileId, dataFetcher);
    this.m2 = rust.WowM2.new(m2Data);
    for (let txid of this.m2.get_texture_ids()) {
      const texData = await fetchFileByID(txid, dataFetcher);
      const blp = rust.WowBlp.new(txid, texData);
      this.blps.push(blp);
    }

    const textureLookupTable = this.m2.get_texture_lookup_table();
    for (let skid of this.m2.get_skin_ids()) {
      const skinData = await fetchFileByID(skid, dataFetcher);
      const skin = rust.WowSkin.new(skinData);
      this.skins.push(skin);
    }
  }
}

class ModelSceneDesc implements Viewer.SceneDesc {
  public id: string;

  constructor(public name: string, public fileId: number) {
    this.id = fileId.toString();
  }

  public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
    const dataFetcher = context.dataFetcher;
    await initFileList(dataFetcher);
    rust.init_panic_hook();
    const model = new WowModel(this.fileId);
    const holder = new DebugTexHolder();
    await model.load(dataFetcher);
    let entries: DebugTex[] = [];
    for (let blp of model.blps) {
      const texPath = getFilePath(blp.file_id);
      entries.push({
        name: texPath,
        width: blp.header.width,
        height: blp.header.height,
        blp: blp,
      });
    }
    holder.addTextures(device, entries);
    return new WowModelScene(device, model, holder);
  }
}

class World {
  public wdt: WowWdt;
  public blps: WowBlp[] = [];
  public adts: WowAdt[] = [];
  constructor(public fileId: number) {
  }

  public async load(dataFetcher: DataFetcher) {
    this.wdt = rust.WowWdt.new(await fetchFileByID(this.fileId, dataFetcher));
    for (let fileIDs of this.wdt.get_loaded_map_data()) {
      // TODO handle obj1 (LOD) adts
      const adt = rust.WowAdt.new(await fetchFileByID(fileIDs.root_adt, dataFetcher));
      adt.append_obj_adt(await fetchFileByID(fileIDs.obj0_adt, dataFetcher));
      adt.append_tex_adt(await fetchFileByID(fileIDs.tex0_adt, dataFetcher));
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
    await initFileList(dataFetcher);
    rust.init_panic_hook();
    const wdt = new World(this.fileId);
    console.log('loading wdt')
    await wdt.load(dataFetcher);
    console.log('done')
    const holder = new DebugTexHolder();
    let entries: DebugTex[] = [];

    const d = new ModelSceneDesc('Kel-Thuzad throne', 204065);
    return d.createScene(device, context);
  }
}

const sceneDescs = [
    "Models",
    new ModelSceneDesc('Arathi farmhouse', 203656),
    new ModelSceneDesc('Kel-Thuzad throne', 204065),
    new ModelSceneDesc('Threshadon corpse', 201573),
    new ModelSceneDesc('Darkshore Glaivemaster', 201531),
    new ModelSceneDesc('Windmill', 200566),

    "WDTs",
    new WdtSceneDesc('Zul-Farak', 791169),
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs, hidden: false };
