import * as Viewer from '../viewer.js';
import { SceneContext } from '../SceneBase.js';
import { rust } from '../rustlib.js';
import { WowM2, WowSkin, WowBlp, WowPixelFormat, WowWdt, WowAdt, WowAdtChunkDescriptor, WowDoodad, WowSkinSubmesh, WowBatch, WowAdtMapObjectDefinition } from '../../rust/pkg/index.js';
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
import { mat4, vec3 } from 'gl-matrix';
import { ModelData, SkinData, AdtData, WorldData, DoodadData, WmoData, WmoBatchData, AdtWmoDef } from './data.js';
import { getMatrixTranslation } from "../MathHelpers.js";
import { fetchFileByID, fetchDataByFileID, initFileList, getFilePath } from "./util.js";
import { CameraController } from '../Camera.js';
import { TextureListHolder, Panel } from '../ui.js';
import { GfxTopology, convertToTriangleIndexBuffer } from '../gfx/helpers/TopologyHelpers.js';
import { drawWorldSpaceText, getDebugOverlayCanvas2D } from '../DebugJunk.js';

const id = 'WorldOfWarcaft';
const name = 'World of Warcraft';

const noclipSpaceFromAdtSpace = mat4.fromValues(
    0, 0, -1, 0,
    -1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 0, 1,
);

const noclipSpaceFromModelSpace = mat4.fromValues(
    0, 0, 1, 0,
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 0, 1,
);

const noclipSpaceFromPlacementSpace = mat4.fromValues(
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
)

export const adtSpaceFromPlacementSpace: mat4 = mat4.invert(mat4.create(), noclipSpaceFromAdtSpace);
mat4.mul(adtSpaceFromPlacementSpace, adtSpaceFromPlacementSpace, noclipSpaceFromPlacementSpace);

export const adtSpaceFromModelSpace: mat4 = mat4.invert(mat4.create(), noclipSpaceFromAdtSpace);
mat4.mul(adtSpaceFromModelSpace, adtSpaceFromModelSpace, noclipSpaceFromModelSpace);

export const placementSpaceFromModelSpace: mat4 = mat4.invert(mat4.create(), noclipSpaceFromPlacementSpace);
mat4.mul(placementSpaceFromModelSpace, placementSpaceFromModelSpace, noclipSpaceFromModelSpace);

const wmoBindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 2, numSamplers: 4 }, // ub_SceneParams
];

const terrainBindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 1, numSamplers: 4 }, // ub_SceneParams
];

class WmoProgram extends DeviceProgram {
  public static a_Position = 0;
  public static a_Normal = 1;
  public static a_Color = 2;
  public static a_TexCoord = 3;

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
layout(location = ${WmoProgram.a_Position}) attribute vec3 a_Position;
layout(location = ${WmoProgram.a_Normal}) attribute vec3 a_Normal;
layout(location = ${WmoProgram.a_Color}) attribute vec4 a_Color;
layout(location = ${WmoProgram.a_TexCoord}) attribute vec2 a_TexCoord;

void mainVS() {
    gl_Position = Mul(u_Projection, Mul(u_ModelView, Mul(u_Transform, vec4(a_Position, 1.0))));
    vec3 t_LightDirection = normalize(vec3(.2, -1, .5));
    v_UV = a_TexCoord;
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

class ModelRenderer {
  private skinData: SkinData[] = [];
  private vertexBuffer: GfxVertexBufferDescriptor;
  private indexBuffer: GfxIndexBufferDescriptor;
  private inputLayout: GfxInputLayout;

  constructor(device: GfxDevice, public model: ModelData, renderHelper: GfxRenderHelper) {
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

    for (let skin of this.model.skins) {
      this.skinData.push(new SkinData(skin));
    }

    this.vertexBuffer = {
      buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, this.model.m2.get_vertex_data().buffer),
      byteOffset: 0,
    };

    this.indexBuffer = {
      buffer: makeStaticDataBuffer(device, GfxBufferUsage.Index, this.skinData[0].indexBuffer.buffer),
      byteOffset: 0,
    };
  }

  public setOnRenderInst(renderInst: GfxRenderInst, textureCache: TextureCache): void {
    const skin = this.skinData[0];
    for (let batch of skin.batches) {
      const submesh = skin.submeshes[batch.skin_submesh_index];
      renderInst.setVertexInput(this.inputLayout, [this.vertexBuffer], this.indexBuffer);
      renderInst.drawIndexes(submesh.index_count, submesh.index_start);
      const m2TextureIndex = this.model.textureLookupTable[batch.texture_combo_index]; // FIXME handle more than 1 batch texture
      const blp = this.model.blps[m2TextureIndex];
      const blpId = this.model.blpIds[m2TextureIndex];
      const mapping = textureCache.getTextureMapping(blpId, blp);
      renderInst.setSamplerBindingsFromTextureMappings([mapping]);
    }
  }
  
  public destroy(device: GfxDevice): void {
    device.destroyBuffer(this.vertexBuffer.buffer);
    device.destroyBuffer(this.indexBuffer.buffer);
  }
}

class AdtModelRenderer {
  public modelIdsToDoodads: Map<number, DoodadData[]>;
  public modelIdsToModelRenderers: Map<number, ModelRenderer>;

  constructor(device: GfxDevice, private textureCache: TextureCache, public adt: AdtData, renderHelper: GfxRenderHelper) {
    this.modelIdsToDoodads = new Map();
    this.modelIdsToModelRenderers = new Map();
    for (let doodad of adt.innerAdt.doodads) {
      const doodadData = DoodadData.fromAdtDoodad(doodad);
      let doodadArray = this.modelIdsToDoodads.get(doodad.name_id)
      if (doodadArray) {
        doodadArray.push(doodadData);
      } else {
        this.modelIdsToDoodads.set(doodad.name_id, [doodadData]);
      }
    }

    for (let modelId of this.modelIdsToDoodads.keys()) {
      const modelData = adt.models.get(modelId);
      if (!modelData) {
        throw new Error(`couldn't find model with id ${modelId}`)
      }
      this.modelIdsToModelRenderers.set(modelId, new ModelRenderer(device, modelData, renderHelper));
    }
  }

  public prepareToRender(renderInstManager: GfxRenderInstManager): void {
    for (let [modelId, doodads] of this.modelIdsToDoodads) {
      const modelRenderer = this.modelIdsToModelRenderers.get(modelId)!;
      const template = renderInstManager.pushTemplateRenderInst();
      modelRenderer.setOnRenderInst(template, this.textureCache);
      for (let doodad of doodads) {
        const renderInst = renderInstManager.newRenderInst();
        let offs = renderInst.allocateUniformBuffer(ModelProgram.ub_ModelParams, 16);
        const mapped = renderInst.mapUniformBufferF32(ModelProgram.ub_ModelParams);
        offs += fillMatrix4x4(mapped, offs, doodad.modelMatrix);
        renderInstManager.submitRenderInst(renderInst);
      }
      renderInstManager.popTemplateRenderInst();
    }
  }

  public destroy(device: GfxDevice): void {
    for (let modelRenderer of this.modelIdsToModelRenderers.values()) {
      modelRenderer.destroy(device);
    }
  }
}

class WmoRenderer {
  private inputLayout: GfxInputLayout;
  private vertexBuffers: GfxVertexBufferDescriptor[][] = [];
  private indexBuffers: GfxIndexBufferDescriptor[] = [];
  private batches: WmoBatchData[][] = [];

  constructor(device: GfxDevice, private wmo: WmoData, private textureCache: TextureCache, renderHelper: GfxRenderHelper) {
    const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
      { location: WmoProgram.a_Position, bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_RGB, },
      { location: WmoProgram.a_Normal,   bufferIndex: 1, bufferByteOffset: 0, format: GfxFormat.F32_RGB, },
      { location: WmoProgram.a_TexCoord, bufferIndex: 2, bufferByteOffset: 0, format: GfxFormat.F32_RG, },
    ];
    const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
      { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex, },
      { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex, },
      { byteStride: 8, frequency: GfxVertexBufferFrequency.PerVertex, },
    ];
    const indexBufferFormat: GfxFormat = GfxFormat.U16_R;
    this.inputLayout = renderHelper.renderCache.createInputLayout({ vertexAttributeDescriptors, vertexBufferDescriptors, indexBufferFormat });

    for (let group of wmo.groups) {
      this.vertexBuffers.push(group.getVertexBuffers(device));
      this.indexBuffers.push(group.getIndexBuffer(device));
      this.batches.push(group.getBatches());
    }
  }

  private getBatchTextureMapping(batch: WmoBatchData): (TextureMapping | null)[] {
    const material = this.wmo.materials[batch.materialId];
    const mappings = []
    for (let blpId of [material.texture_1, material.texture_2, material.texture_3]) {
      if (blpId === 0) {
        mappings.push(null);
      } else {
        const blp = this.wmo.blps.get(blpId);
        if (!blp) {
          throw new Error(`couldn't find WMO BLP with id ${material.texture_1}`);
        }
        mappings.push(this.textureCache.getTextureMapping(material.texture_1, blp));
      }
    }
    return mappings;
  }

  public prepareToRender(renderInstManager: GfxRenderInstManager) {
    const template = renderInstManager.pushTemplateRenderInst();
    for (let i=0; i<this.vertexBuffers.length; i++) {
      template.setVertexInput(this.inputLayout, this.vertexBuffers[i], this.indexBuffers[i]);
      for (let batch of this.batches[i]) {
        const renderInst = renderInstManager.newRenderInst();
        const textureMappings = this.getBatchTextureMapping(batch);
        renderInst.setSamplerBindingsFromTextureMappings(textureMappings);
        renderInst.drawIndexes(batch.indexCount, batch.indexStart);
        renderInstManager.submitRenderInst(renderInst);
      }
    }
    renderInstManager.popTemplateRenderInst();
  }

  public destroy(device: GfxDevice) {
  }
}

class WmoModelRenderer {
  public doodads: DoodadData[] = [];

  constructor(device: GfxDevice, wmo: WmoData) {
    for (let doodadDef of wmo.wmo.doodad_defs) {
      this.doodads.push(DoodadData.fromWmoDoodad(doodadDef));
    }
  }

  public prepareToRender(renderInstManager: GfxRenderInstManager) {
  }

  public destroy(device: GfxDevice) {
  }
}

class AdtWmoRenderer {
  public wmoProgram: GfxProgram;
  public modelProgram: GfxProgram;
  public wmoIdToRenderer: Map<number, WmoRenderer>;
  public wmoIdToModelRenderer: Map<number, WmoModelRenderer>;
  public wmoIdToWmoDefs: Map<number, AdtWmoDef[]>;
  public visible: boolean = true;

  constructor(device: GfxDevice, adt: AdtData, textureCache: TextureCache, renderHelper: GfxRenderHelper) {
    this.wmoProgram = renderHelper.renderCache.createProgram(new WmoProgram());
    this.modelProgram = renderHelper.renderCache.createProgram(new ModelProgram());
    this.wmoIdToRenderer = new Map();
    this.wmoIdToModelRenderer = new Map();
    this.wmoIdToWmoDefs = new Map();

    for (let wmoDef of adt.wmoDefs) {
      let defs = this.wmoIdToWmoDefs.get(wmoDef.wmoId);
      if (defs) {
        defs.push(wmoDef);
      } else {
        this.wmoIdToWmoDefs.set(wmoDef.wmoId, [wmoDef]);
      }
    }

    for (let [wmoId, wmo] of adt.wmos.entries()) {
      this.wmoIdToRenderer.set(wmoId, new WmoRenderer(device, wmo, textureCache, renderHelper));
      this.wmoIdToModelRenderer.set(wmoId, new WmoModelRenderer(device, wmo));
    }
  }

  public prepareToRender(renderInstManager: GfxRenderInstManager) {
    if (!this.visible) return;
    const cam = mat4.create();
    mat4.mul(cam, window.main.viewer.camera.clipFromWorldMatrix, noclipSpaceFromAdtSpace);
    const template = renderInstManager.pushTemplateRenderInst();
    template.setGfxProgram(this.wmoProgram);
    template.setBindingLayouts(wmoBindingLayouts);
    for (let [wmoId, wmoDefs] of this.wmoIdToWmoDefs.entries()) {
      let renderer = this.wmoIdToRenderer.get(wmoId)!;
      for (let def of wmoDefs) {
        let offs = template.allocateUniformBuffer(ModelProgram.ub_ModelParams, 16);
        const mapped = template.mapUniformBufferF32(ModelProgram.ub_ModelParams);
        offs += fillMatrix4x4(mapped, offs, def.modelMatrix);
        let v = vec3.create();
        getMatrixTranslation(v, def.modelMatrix);
        drawWorldSpaceText(getDebugOverlayCanvas2D(), cam, v, `${def.def.rotation.x}, ${def.def.rotation.y}, ${def.def.rotation.z}`);
        renderer.prepareToRender(renderInstManager);
      }
    }

    /*
    template.setGfxProgram(this.modelProgram);
    template.setBindingLayouts(modelBindingLayouts);
    for (let i=0; i<this.wmoIdToModelRenderer.length; i++) {
      this.wmoIdToModelRenderer[i].prepareToRender(renderInstManager);
    }
    */

    renderInstManager.popTemplateRenderInst();
  }

  public destroy(device: GfxDevice) {
    for (let renderer of this.wmoIdToModelRenderer.values()) {
      renderer.destroy(device);
    }
    for (let renderer of this.wmoIdToRenderer.values()) {
      renderer.destroy(device);
    }
  }
}

class AdtTerrainRenderer {
  private inputLayout: GfxInputLayout;
  public indexBuffer: GfxIndexBufferDescriptor;
  public vertexBuffer: GfxVertexBufferDescriptor;
  public adtChunks: WowAdtChunkDescriptor[] = [];

  constructor(device: GfxDevice, renderHelper: GfxRenderHelper, public adt: AdtData, private textureCache: TextureCache) {
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
  private wmoRenderers: AdtWmoRenderer[] = [];
  private terrainProgram: GfxProgram;
  private modelProgram: GfxProgram;

  constructor(device: GfxDevice, public world: WorldData, public textureHolder: DebugTexHolder, public renderHelper: GfxRenderHelper) {
    const textureCache = new TextureCache(this.renderHelper.renderCache);
    this.terrainProgram = this.renderHelper.renderCache.createProgram(new TerrainProgram());
    this.modelProgram = this.renderHelper.renderCache.createProgram(new ModelProgram());

    for (let adt of this.world.adts) {
      this.terrainRenderers.push(new AdtTerrainRenderer(device, this.renderHelper, adt, textureCache));
      this.modelRenderers.push(new AdtModelRenderer(device, textureCache, adt, renderHelper));
      this.wmoRenderers.push(new AdtWmoRenderer(device, adt, textureCache, this.renderHelper));
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
    mat4.mul(viewMat, viewerInput.camera.viewMatrix, noclipSpaceFromAdtSpace);
    offs += fillMatrix4x4(mapped, offs, viewMat);

    this.terrainRenderers.forEach(terrainRenderer => {
      terrainRenderer.prepareToRender(this.renderHelper.renderInstManager);
    });

    template.setBindingLayouts(modelBindingLayouts);
    template.setGfxProgram(this.modelProgram);
    this.modelRenderers.forEach(modelRenderer => {
      modelRenderer.prepareToRender(this.renderHelper.renderInstManager);
    });

    this.wmoRenderers.forEach(wmoRenderer => {
      wmoRenderer.prepareToRender(this.renderHelper.renderInstManager);
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
    this.modelRenderers.forEach(modelRenderer => {
      modelRenderer.destroy(device);
    })
    this.wmoRenderers.forEach(wmoRenderer => {
      wmoRenderer.destroy(device);
    })
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
    const wdt = new WorldData(this.fileId);
    console.log('loading wdt')
    await wdt.load(dataFetcher);
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
    new WdtSceneDesc("Strat", 827115),
    new WdtSceneDesc("Caverns of Time", 829736),
    new WdtSceneDesc("Ahn'qiraj", 775637),
    new WdtSceneDesc("Deeprun Tram", 780788),
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs, hidden: false };
