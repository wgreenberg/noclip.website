import { WowBlp, WowPixelFormat } from "../../rust/pkg/index.js";
import * as Viewer from '../viewer.js';
import ArrayBufferSlice from "../ArrayBufferSlice.js";
import { decompressBC, surfaceToCanvas } from "../Common/bc_texture.js";
import { SamplerSettings } from "../Halo1/tex.js";
import { TextureMapping, TextureHolder, LoadedTexture } from "../TextureHolder.js";
import { makeSolidColorTexture2D } from "../gfx/helpers/TextureHelpers.js";
import { GfxDevice, GfxTextureDimension, GfxTextureUsage, GfxTexFilterMode, GfxMipFilterMode, GfxWrapMode, makeTextureDescriptor2D } from "../gfx/platform/GfxPlatform.js";
import { GfxFormat } from "../gfx/platform/GfxPlatformFormat.js";
import { GfxTexture, GfxSampler } from "../gfx/platform/GfxPlatformImpl.js";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache.js";
import { rust } from "../rustlib.js";

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
  const mipMetadata = blp.get_mip_metadata();
  const mipmapCount = mipMetadata.length;

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

    public getTexture(blp: WowBlp, debug = false, submap = 0): GfxTexture {
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

    public getTextureMapping(blp: WowBlp, debug = false, submap = 0, samplerSettings: SamplerSettings = { wrap: true }): TextureMapping {
      const mapping = new TextureMapping();
      mapping.gfxTexture = this.getTexture(blp, debug, submap);
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
    let gfxTexture: GfxTexture =  makeSolidColorTexture2D(device, {
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
