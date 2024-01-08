import * as Viewer from '../viewer.js';
import { SceneContext } from '../SceneBase.js';
import { rust } from '../rustlib.js';
import { WowM2, WowSkin, WowBlp, WowPixelFormat } from '../../rust/pkg/index.js';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper.js';
import { DeviceProgram } from '../Program.js';
import { GfxDevice, GfxVertexAttributeDescriptor, GfxInputLayoutBufferDescriptor, GfxVertexBufferFrequency, GfxBufferUsage, GfxVertexBufferDescriptor, GfxBindingLayoutDescriptor, GfxCullMode, GfxIndexBufferDescriptor, makeTextureDescriptor2D, GfxMipFilterMode, GfxTexFilterMode, GfxWrapMode, GfxTextureDimension, GfxTextureUsage } from '../gfx/platform/GfxPlatform.js';
import { GfxFormat } from '../gfx/platform/GfxPlatformFormat.js';
import { GfxBuffer, GfxInputLayout, GfxProgram, GfxSampler, GfxTexture } from '../gfx/platform/GfxPlatformImpl.js';
import { GfxRenderInst, GfxRenderInstManager } from '../gfx/render/GfxRenderInstManager.js';
import { makeStaticDataBuffer } from '../gfx/helpers/BufferHelpers.js';
import { makeBackbufferDescSimple, standardFullClearRenderPassDescriptor, pushAntialiasingPostProcessPass } from '../gfx/helpers/RenderGraphHelpers.js';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph.js';
import { fillMatrix4x4 } from '../gfx/helpers/UniformBufferHelpers.js';
import { DataFetcher } from '../DataFetcher.js';
import { decompressBC, surfaceToCanvas } from '../Common/bc_texture.js';
import { TextureHolder, LoadedTexture, TextureMapping } from '../TextureHolder.js';
import { translateImageFormat } from '../fres_nx/tegra_texture.js';
import { SamplerSettings } from '../Halo1/tex.js';
import { makeSolidColorTexture2D } from '../gfx/helpers/TextureHelpers.js';
import { GfxRenderCache } from '../gfx/render/GfxRenderCache.js';
import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { nArray } from '../util.js';
import { Texture } from 'librw';

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
    private textureMapping: (TextureMapping | null)[] = nArray(2, () => null);
    private vertexBuffer: GfxBuffer;
    private indexBufferDescriptor: GfxIndexBufferDescriptor;
    private indexBuffer: GfxBuffer;
    private indexCount: number;
    public vertexBufferDescriptors: GfxVertexBufferDescriptor[];

    constructor(device: GfxDevice, private textureCache: TextureCache, public blps: WowBlp[], public m2: WowM2, private inputLayout: GfxInputLayout, private skin: WowSkin) {
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

class WowModelScene implements Viewer.SceneGfx {
    private renderHelper: GfxRenderHelper;
    private modelRenderers: ModelRenderer[];
    private inputLayout: GfxInputLayout;
    private program: GfxProgram;

    constructor(device: GfxDevice, private blps: WowBlp[], private m2: WowM2, private skin: WowSkin, public textureHolder: DebugTexHolder) {
      this.renderHelper = new GfxRenderHelper(device);
      const textureCache = new TextureCache(this.renderHelper.renderCache);
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
      this.modelRenderers = [new ModelRenderer(device, textureCache, this.blps, this.m2, this.inputLayout, this.skin)];
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

function getImageFormatByteLength(fmt: GfxFormat, width: number, height: number): number {
    if (fmt === GfxFormat.BC1 || fmt === GfxFormat.BC2 || fmt === GfxFormat.BC3) {
        width = Math.max(width, 4);
        height = Math.max(height, 4);
        const count = ((width * height) / 16);
        if (fmt === GfxFormat.BC1)
            return count * 8;
        else if (fmt === GfxFormat.BC2)
            return count * 16;
        else if (fmt === GfxFormat.BC3)
            return count * 16;
    } else {
        if (fmt === GfxFormat.U8_RGBA_NORM)
          return (width * height) * 4;
        else if (fmt === GfxFormat.U16_RGB_565)
          return (width * height) * 2;
    }
    throw new Error(`unrecognized compressed format ${GfxFormat[fmt]}`)
}

function makeTexture(device: GfxDevice, blp: WowBlp, level = 0): GfxTexture {
    const format = getTextureFormat(blp.header.preferred_format);
    const mipmapCount = 1; // FIXME

    const dimension = GfxTextureDimension.n2D;
    let depth = 1;

    const textureDescriptor = {
        dimension,
        pixelFormat: format,
        width: blp.header.width,
        height: blp.header.height,
        numLevels: mipmapCount,
        depth,
        usage: GfxTextureUsage.Sampled,
    };

    const texture = device.createTexture(textureDescriptor!);
    const levelDatas = [];
    let byteOffset = 0;
    let w = blp.header.width;
    let h = blp.header.height;
    for (let i = 0; i < mipmapCount; i++) {
        const sliceByteLength = getImageFormatByteLength(format, w, h);

        const texData = blp.get_texture_data();
        let buffer = new ArrayBufferSlice(texData.buffer, byteOffset, sliceByteLength * depth);

        let levelData: ArrayBufferView;
        if (format === GfxFormat.U16_RGB_565) {
            levelData = buffer.createTypedArray(Uint16Array);
        } else {
            levelData = buffer.createTypedArray(Uint8Array);
        }

        levelDatas.push(levelData);

        byteOffset += sliceByteLength * depth;
        w = Math.max(w >>> 1, 1);
        h = Math.max(h >>> 1, 1);
    }

    device.uploadTextureData(texture, 0, levelDatas);
    return texture;
}

export class TextureCache {
    public textures: Map<number, GfxTexture>;
    public default2DTexture: GfxTexture;

    constructor(private renderCache: GfxRenderCache) {
        this.textures = new Map();
        this.default2DTexture = makeSolidColorTexture2D(renderCache.device, {
            r: 0.5,
            g: 0.5,
            b: 0.5,
            a: 1.0,
        });
    }

    public async getTexture(blp: WowBlp, debug = false, submap = 0): Promise<GfxTexture> {
        if (debug) {
            return this.default2DTexture;
        }

        if (this.textures.has(blp.file_id)) {
          return this.textures.get(blp.file_id)!;
        } else {
          const texture = makeTexture(this.renderCache.device, blp);
          this.textures.set(blp.file_id, texture);
          return texture;
        }
    }

    public getSampler(samplerSettings: SamplerSettings): GfxSampler {
        return this.renderCache.createSampler({
            minFilter: GfxTexFilterMode.Bilinear,
            magFilter: GfxTexFilterMode.Bilinear,
            mipFilter: GfxMipFilterMode.Linear,
            minLOD: 0,
            maxLOD: 100,
            wrapS: samplerSettings.wrap ? GfxWrapMode.Repeat : GfxWrapMode.Clamp,
            wrapT: samplerSettings.wrap ? GfxWrapMode.Repeat : GfxWrapMode.Clamp,
        });
    }

    public async getTextureMapping(blp: WowBlp, debug = false, submap = 0, samplerSettings: SamplerSettings = { wrap: true }): Promise<TextureMapping> {
        const mapping = new TextureMapping();
        mapping.gfxTexture = await this.getTexture(blp, debug, submap);
        mapping.gfxSampler = this.getSampler(samplerSettings);
        return mapping;
    }

    public destroy(device: GfxDevice) {
        device.destroyTexture(this.default2DTexture);
        for (let tex of this.textures.values()) {
            device.destroyTexture(tex);
        }
    }
}

function getTextureFormat(format: WowPixelFormat): GfxFormat {
  switch (format) {
    case rust.WowPixelFormat.Dxt1: return GfxFormat.BC1;
    case rust.WowPixelFormat.Dxt3: return GfxFormat.BC2;
    case rust.WowPixelFormat.Dxt5: return GfxFormat.BC3;
    case rust.WowPixelFormat.Rgb565: return GfxFormat.U16_RGB_565;
    // the rest we convert to U8_RGBA_NORM
    default:
      return GfxFormat.U8_RGBA_NORM;
  }
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
    const blps: WowBlp[] = [];
    for (let txid of m2.get_texture_ids()) {
      let texPath = fileList.getFilename(txid);
      console.log(texPath);
      const texData = await dataFetcher.fetchData(`/wow/${texPath}`)
      const blp = rust.WowBlp.new(txid, texData.createTypedArray(Uint8Array));
      blps.push(blp);
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
    return new WowModelScene(device, blps, m2, skin, holder);
  }
}

const sceneDescs = [
    "Models",
    new WowSceneDesc('Arathi farmhouse', 203656),
    new WowSceneDesc('Kel-Thuzad throne', 204065),
    new WowSceneDesc('Threshadon corpse', 201573),
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs, hidden: false };
