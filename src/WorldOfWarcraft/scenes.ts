import * as Viewer from '../viewer.js';
import { SceneContext } from '../SceneBase.js';
import { rust } from '../rustlib.js';
import { WowM2, WowSkin, WowBlp } from '../../rust/pkg/index.js';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper.js';
import { DeviceProgram } from '../Program.js';
import { GfxDevice, GfxVertexAttributeDescriptor, GfxInputLayoutBufferDescriptor, GfxVertexBufferFrequency, GfxBufferUsage, GfxVertexBufferDescriptor, GfxBindingLayoutDescriptor, GfxCullMode, GfxIndexBufferDescriptor, makeTextureDescriptor2D } from '../gfx/platform/GfxPlatform.js';
import { GfxFormat } from '../gfx/platform/GfxPlatformFormat.js';
import { GfxBuffer, GfxInputLayout, GfxProgram } from '../gfx/platform/GfxPlatformImpl.js';
import { GfxRenderInst, GfxRenderInstManager } from '../gfx/render/GfxRenderInstManager.js';
import { makeStaticDataBuffer } from '../gfx/helpers/BufferHelpers.js';
import { makeBackbufferDescSimple, standardFullClearRenderPassDescriptor, pushAntialiasingPostProcessPass } from '../gfx/helpers/RenderGraphHelpers.js';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph.js';
import { fillMatrix4x4 } from '../gfx/helpers/UniformBufferHelpers.js';
import { DataFetcher } from '../DataFetcher.js';
import { decompressBC, surfaceToCanvas } from '../Common/bc_texture.js';
import { TextureHolder, LoadedTexture } from '../TextureHolder.js';
import { translateImageFormat } from '../fres_nx/tegra_texture.js';

const id = 'WorldOfWarcaft';
const name = 'World of Warcraft';

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 1, numSamplers: 0 }, // ub_SceneParams
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

vec4 u_Color = vec4(1.0, 0.0, 1.0, 1.0);

varying vec2 v_LightIntensity;

#ifdef VERT
layout(location = ${ModelProgram.a_Position}) attribute vec3 a_Position;
layout(location = ${ModelProgram.a_Normal}) attribute vec3 a_Normal;

void mainVS() {
    const float t_ModelScale = 20.0;
    gl_Position = Mul(u_Projection, Mul(u_ModelView, vec4(a_Position * t_ModelScale, 1.0)));
    vec3 t_LightDirection = normalize(vec3(.2, -1, .5));
    float t_LightIntensityF = dot(-a_Normal, t_LightDirection);
    float t_LightIntensityB = dot( a_Normal, t_LightDirection);
    v_LightIntensity = vec2(t_LightIntensityF, t_LightIntensityB);
}
#endif

#ifdef FRAG
void mainPS() {
    float t_LightIntensity = gl_FrontFacing ? v_LightIntensity.x : v_LightIntensity.y;
    float t_LightTint = 0.3 * t_LightIntensity;
    gl_FragColor = u_Color + vec4(t_LightTint, t_LightTint, t_LightTint, 0.0);
}
#endif
`;
}

class ModelRenderer {
    public name: string;
    private vertexBuffer: GfxBuffer;
    private indexBufferDescriptor: GfxIndexBufferDescriptor;
    private indexBuffer: GfxBuffer;
    private indexCount: number;
    public vertexBufferDescriptors: GfxVertexBufferDescriptor[];

    constructor(device: GfxDevice, public m2: WowM2, private inputLayout: GfxInputLayout, private skin: WowSkin) {
      this.name = m2.get_name();
      let buf = m2.get_vertex_data();
      let skinIndices = skin.get_indices();
      this.indexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Index, skinIndices.buffer);
      this.indexCount = skinIndices.length;
      this.indexBufferDescriptor = { buffer: this.indexBuffer, byteOffset: 0 };
      this.vertexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, buf.buffer);
      this.vertexBufferDescriptors = [
        { buffer: this.vertexBuffer, byteOffset: 0, },
      ];
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager): void {
      const renderInst = renderInstManager.newRenderInst();
      renderInst.setVertexInput(this.inputLayout, this.vertexBufferDescriptors, this.indexBufferDescriptor);
      renderInst.drawIndexes(this.indexCount);
      renderInstManager.submitRenderInst(renderInst);
    }

    public destroy(device: GfxDevice): void {
      device.destroyBuffer(this.vertexBuffer);
    }
}

class WowScene implements Viewer.SceneGfx {
    private renderHelper: GfxRenderHelper;
    private modelRenderers: ModelRenderer[];
    private inputLayout: GfxInputLayout;
    private program: GfxProgram;

    constructor(device: GfxDevice, private m2: WowM2, private skin: WowSkin, public textureHolder: DebugTexHolder) {
      this.renderHelper = new GfxRenderHelper(device);
      this.program = this.renderHelper.renderCache.createProgram(new ModelProgram());

      const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
        { location: ModelProgram.a_Position, bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_RGB, },
        { location: ModelProgram.a_Normal,   bufferIndex: 0, bufferByteOffset: 20, format: GfxFormat.F32_RGB, },
      ];
      const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
        { byteStride: rust.WowM2.get_vertex_stride(), frequency: GfxVertexBufferFrequency.PerVertex, },
      ];
      const indexBufferFormat: GfxFormat = GfxFormat.U16_R;
      const cache = this.renderHelper.renderCache;

      this.inputLayout = cache.createInputLayout({ vertexAttributeDescriptors, vertexBufferDescriptors, indexBufferFormat });
      this.modelRenderers = [new ModelRenderer(device, this.m2, this.inputLayout, this.skin)];
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
async function getFileList(dataFetcher: DataFetcher): Promise<FileList> {
  if (!_fileList) {
    _fileList = new FileList();
    await _fileList.load(dataFetcher);
  }
  return _fileList;
}

interface DebugTex {
  name: string;
  width: number;
  height: number;
  blp: WowBlp;
}

class DebugTexHolder extends TextureHolder<DebugTex> {
  public loadTexture(device: GfxDevice, textureEntry: DebugTex): LoadedTexture | null {
    const gfxTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.BC1_SRGB, textureEntry.width, textureEntry.height, 1));
    const tex = textureEntry.blp.get_texture_data();
    const canvases: HTMLCanvasElement[] = [];
    if (textureEntry.blp.header.preferred_format === rust.WowPixelFormat.Dxt1) {
      const decoded = decompressBC({
        type: 'BC1',
        width: textureEntry.blp.header.width,
        height: textureEntry.blp.header.height,
        depth: 1,
        flag: 'SRGB',
        pixels: tex,
      })
      const canvas = document.createElement('canvas');
      surfaceToCanvas(canvas, decoded);
      canvases.push(canvas);
    } else {
      console.log(`${textureEntry.name}: unknown texture ${textureEntry.blp.header.preferred_format}`)
    }

    const viewerTexture: Viewer.Texture = { name: textureEntry.name, surfaces: canvases };
    return { viewerTexture, gfxTexture };
  }
}

class WowSceneDesc implements Viewer.SceneDesc {
  public id: string;

  constructor(public name: string, public fileId: number) {
    this.id = fileId.toString();
  }

  public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
    const dataFetcher = context.dataFetcher;
    rust.init_panic_hook();
    const fileList = await getFileList(dataFetcher);
    const filePath = fileList.getFilename(this.fileId);
    const modelData = await dataFetcher.fetchData(`/wow/${filePath}`);
    const m2 = rust.WowM2.new(modelData.createTypedArray(Uint8Array));
    const holder = new DebugTexHolder();
    const entries: DebugTex[] = [];
    for (let txid of m2.get_texture_ids()) {
      let texPath = fileList.getFilename(txid);
      console.log(texPath);
      const texData = await dataFetcher.fetchData(`/wow/${texPath}`)
      const blp = rust.WowBlp.new(texData.createTypedArray(Uint8Array));
      entries.push({
        name: texPath,
        width: blp.header.width,
        height: blp.header.height,
        blp: blp,
      });
    }
    holder.addTextures(device, entries);
    const skinData = await dataFetcher.fetchData(`/wow/${filePath.replace('.m2', '00.skin')}`);
    const skin = rust.WowSkin.new(skinData.createTypedArray(Uint8Array));
    return new WowScene(device, m2, skin, holder);
  }
}

const sceneDescs = [
    "Models",
    new WowSceneDesc('Arathi farmhouse', 203656),
    new WowSceneDesc('Kel-Thuzad throne', 204065),
    new WowSceneDesc('Threshadon corpse', 201573),
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs, hidden: false };
