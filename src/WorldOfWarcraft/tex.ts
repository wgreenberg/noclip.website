import { WowBlp, WowColorEncoding, WowPixelFormat } from "../../rust/pkg/index.js";
import * as Viewer from '../viewer.js';
import ArrayBufferSlice from "../ArrayBufferSlice.js";
import { decompressBC, surfaceToCanvas } from "../Common/bc_texture.js";
import { SamplerSettings } from "../Halo1/tex.js";
import { TextureMapping, TextureHolder, LoadedTexture } from "../TextureHolder.js";
import { makeSolidColorTexture2D } from "../gfx/helpers/TextureHelpers.js";
import { GfxDevice, GfxTextureDimension, GfxTextureUsage, GfxTexFilterMode, GfxMipFilterMode, GfxWrapMode, makeTextureDescriptor2D, GfxTextureDescriptor } from "../gfx/platform/GfxPlatform.js";
import { GfxFormat } from "../gfx/platform/GfxPlatformFormat.js";
import { GfxTexture, GfxSampler } from "../gfx/platform/GfxPlatformImpl.js";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache.js";
import { rust } from "../rustlib.js";

function getTextureType(blpFile: WowBlp): GfxFormat | undefined {
    switch (blpFile.header.preferred_format) {
        case rust.WowPixelFormat.Dxt1:
            if (blpFile.header.alpha_bit_depth > 0) {
                return GfxFormat.BC1;
            } else {
                return GfxFormat.BC1_SRGB;
            }
        case rust.WowPixelFormat.Dxt3:
            return GfxFormat.BC2;
        case rust.WowPixelFormat.Argb8888:
        case rust.WowPixelFormat.Unspecified:
            return GfxFormat.U8_RGBA_NORM;
        case rust.WowPixelFormat.Argb1555:
            return GfxFormat.U16_RGBA_5551;
        case rust.WowPixelFormat.Argb4444:
            return GfxFormat.U16_RGBA_NORM;
        case rust.WowPixelFormat.Rgb565:
          return GfxFormat.U16_RGB_565;
        case rust.WowPixelFormat.Dxt5:
          return GfxFormat.BC3;
        case rust.WowPixelFormat.Argb2565:
            return GfxFormat.U8_RGBA_SRGB; // this seems wrong?
        default:
            break;
    }
    return undefined;
}

function makeTexture(device: GfxDevice, blp: WowBlp, level = 0): GfxTexture {
  if (blp === undefined) {
    return null!;
  }
  const format = getTextureType(blp)!;
  if (format === GfxFormat.U8_RGBA_NORM) {
    return null!;
  }
  const mipMetadata = blp.get_mip_metadata();
  const mipmapCount = mipMetadata.length;

  const textureDescriptor = {
    dimension: GfxTextureDimension.n2D,
    pixelFormat: format,
    width: blp.header.width,
    height: blp.header.height,
    numLevels: mipmapCount,
    depth: 1,
    usage: GfxTextureUsage.Sampled,
  };

  const texture = device.createTexture(textureDescriptor!);
  const levelDatas = [];
  for (let i = 0; i < mipmapCount; i++) {
    const mipBuf = blp.get_mip_data(i);
    if ([GfxFormat.U16_RGB_565, GfxFormat.U16_RGBA_5551, GfxFormat.U16_RGBA_NORM].includes(format)) {
      levelDatas.push(new Uint16Array(mipBuf.buffer));
    } else {
      levelDatas.push(mipBuf);
    }
  }

  device.uploadTextureData(texture, 0, levelDatas);
  return texture;
}

export class TextureCache {
    public textures: Map<number, GfxTexture>;
    public default2DTexture: GfxTexture;
    public allBlackTexture: GfxTexture;
    public allWhiteTexture: GfxTexture;

    constructor(private renderCache: GfxRenderCache) {
      this.textures = new Map();
      this.default2DTexture = makeSolidColorTexture2D(renderCache.device, {
        r: 0.5,
        g: 0.5,
        b: 0.5,
        a: 1.0,
      });
      this.allBlackTexture = makeSolidColorTexture2D(renderCache.device, {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        a: 1.0,
      });
      this.allWhiteTexture = makeSolidColorTexture2D(renderCache.device, {
        r: 1.0,
        g: 1.0,
        b: 1.0,
        a: 1.0,
      });
    }

    public getAllBlackTextureMapping(): TextureMapping {
      const mapping = new TextureMapping();
      mapping.gfxTexture = this.allBlackTexture;
      mapping.gfxSampler = this.getSampler({ wrap: false });
      return mapping;
    }

    public getAllWhiteTextureMapping(): TextureMapping {
      const mapping = new TextureMapping();
      mapping.gfxTexture = this.allWhiteTexture;
      mapping.gfxSampler = this.getSampler({ wrap: false });
      return mapping;
    }

    public getTexture(fileId: number, blp: WowBlp, debug = false, submap = 0): GfxTexture {
      if (debug) {
        return this.default2DTexture;
      }

      if (this.textures.has(fileId)) {
        return this.textures.get(fileId)!;
      } else {
        const texture = makeTexture(this.renderCache.device, blp);
        this.textures.set(fileId, texture);
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

    public getTextureMapping(fileId: number, blp: WowBlp, debug = false, submap = 0, samplerSettings: SamplerSettings = { wrap: true }): TextureMapping {
      const mapping = new TextureMapping();
      mapping.gfxTexture = this.getTexture(fileId, blp, debug, submap);
      mapping.gfxSampler = this.getSampler(samplerSettings);
      return mapping;
    }

    public getAlphaTextureMapping(device: GfxDevice, texData: Uint8Array): TextureMapping {
      let w = 64;
      let h = texData.length === 2048 ? 32 : 64;
      const textureDescriptor: GfxTextureDescriptor = {
        dimension: GfxTextureDimension.n2D,
        pixelFormat: GfxFormat.U8_RGBA_NORM,
        width: w,
        height: h,
        numLevels: 1,
        depth: 1,
        usage: GfxTextureUsage.Sampled,
      };
      const texture = device.createTexture(textureDescriptor);
      device.uploadTextureData(texture, 0, [texData]);
      const mapping = new TextureMapping();
      mapping.gfxTexture = texture;
      mapping.gfxSampler = this.getSampler({ wrap: false });
      return mapping;
    }

    public destroy(device: GfxDevice) {
      device.destroyTexture(this.default2DTexture);
      device.destroyTexture(this.allBlackTexture);
      device.destroyTexture(this.allWhiteTexture);
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

export interface DebugTex {
  name: string;
  width: number;
  height: number;
  blp: WowBlp;
}

export class DebugTexHolder extends TextureHolder<DebugTex> {
  public loadTexture(device: GfxDevice, textureEntry: DebugTex): LoadedTexture | null {
    const tex = textureEntry.blp.get_texture_data();
    const canvases: HTMLCanvasElement[] = [];
    let gfxTexture: GfxTexture = makeSolidColorTexture2D(device, {
      r: 0.5,
      g: 0.5,
      b: 0.5,
      a: 1.0,
    });
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
      gfxTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.BC1_SRGB, textureEntry.width, textureEntry.height, 1));
      surfaceToCanvas(canvas, decoded);
      canvases.push(canvas);
    } else if (textureEntry.blp.header.preferred_format == rust.WowPixelFormat.Dxt3) {
      const decoded = decompressBC({
        type: 'BC2',
        width: textureEntry.blp.header.width,
        height: textureEntry.blp.header.height,
        depth: 1,
        flag: 'SRGB',
        pixels: tex,
      })
      const canvas = document.createElement('canvas');
      surfaceToCanvas(canvas, decoded);
      gfxTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.BC2_SRGB, textureEntry.width, textureEntry.height, 1));
      canvases.push(canvas);
    } else {
      console.log(`${textureEntry.name}: unknown texture ${textureEntry.blp.header.preferred_format}`)
    }

    const viewerTexture: Viewer.Texture = { name: textureEntry.name, surfaces: canvases };
    return { viewerTexture, gfxTexture };
  }
}
