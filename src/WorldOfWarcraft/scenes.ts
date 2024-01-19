import * as Viewer from '../viewer.js';
import { SceneContext } from '../SceneBase.js';
import { rust } from '../rustlib.js';
import { WowM2, WowSkin, WowBlp, WowPixelFormat, WowWdt, WowAdt, WowAdtChunkDescriptor, WowDoodad, WowSkinSubmesh, WowBatch, WowAdtWmoDefinition } from '../../rust/pkg/index.js';
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
import { ModelData, SkinData, AdtData, WorldData, DoodadData, WmoData, WmoBatchData, WmoDefinition } from './data.js';
import { getMatrixTranslation } from "../MathHelpers.js";
import { fetchFileByID, fetchDataByFileID, initFileList, getFilePath } from "./util.js";
import { CameraController, computeViewSpaceDepthFromWorldSpaceAABB } from '../Camera.js';
import { TextureListHolder, Panel } from '../ui.js';
import { GfxTopology, convertToTriangleIndexBuffer } from '../gfx/helpers/TopologyHelpers.js';
import { drawWorldSpaceAABB, drawWorldSpaceText, getDebugOverlayCanvas2D } from '../DebugJunk.js';
import { AABB } from '../Geometry.js';

const id = 'WorldOfWarcaft';
const name = 'World of Warcraft';

export const noclipSpaceFromAdtSpace = mat4.fromValues(
  0, 0, -1, 0,
  -1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
);

export const noclipSpaceFromModelSpace = mat4.fromValues(
  0, 0, 1, 0,
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
);

export const noclipSpaceFromPlacementSpace = mat4.fromValues(
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
)

const MAX_WMO_RENDER_DIST = 10000;
const MAX_ADT_RENDER_DIST = 10000;

export const adtSpaceFromPlacementSpace: mat4 = mat4.invert(mat4.create(), noclipSpaceFromAdtSpace);
mat4.mul(adtSpaceFromPlacementSpace, adtSpaceFromPlacementSpace, noclipSpaceFromPlacementSpace);

export const adtSpaceFromModelSpace: mat4 = mat4.invert(mat4.create(), noclipSpaceFromAdtSpace);
mat4.mul(adtSpaceFromModelSpace, adtSpaceFromModelSpace, noclipSpaceFromModelSpace);

export const placementSpaceFromModelSpace: mat4 = mat4.invert(mat4.create(), noclipSpaceFromPlacementSpace);
mat4.mul(placementSpaceFromModelSpace, placementSpaceFromModelSpace, noclipSpaceFromModelSpace);

export const modelSpaceFromAdtSpace: mat4 = mat4.invert(mat4.create(), adtSpaceFromModelSpace);

const wmoBindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 2, numSamplers: 4 },
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
    gl_FragColor = tex;
}
#endif
`;
}

const terrainBindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 1, numSamplers: 5 },
];

class TerrainProgram extends DeviceProgram {
  public static a_Position = 0;
  public static a_Normal = 1;
  public static a_Color = 2;
  public static a_ChunkIndex = 3;

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
layout(binding = 4) uniform sampler2D u_AlphaTexture0;

varying vec3 v_Normal;
varying vec4 v_Color;
varying vec3 v_Binormal;
varying vec3 v_Tangent;
varying vec3 v_Position;
varying vec2 v_ChunkCoords;

#ifdef VERT
layout(location = ${TerrainProgram.a_Position}) attribute vec3 a_Position;
layout(location = ${TerrainProgram.a_Normal}) attribute vec3 a_Normal;
layout(location = ${TerrainProgram.a_Color}) attribute vec4 a_Color;
layout(location = ${TerrainProgram.a_ChunkIndex}) attribute float a_ChunkIndex;

void mainVS() {
    float iX = mod(a_ChunkIndex, 17.0);
    float iY = floor(a_ChunkIndex/17.0);

    if (iX > 8.01) {
        iY = iY + 0.5;
        iX = iX - 8.5;
    }

    v_ChunkCoords = vec2(iX, iY);
    v_Color = a_Color;
    gl_Position = Mul(u_Projection, Mul(u_ModelView, vec4(a_Position, 1.0)));
}
#endif

#ifdef FRAG
vec4 mixTex(vec4 tex0, vec4 tex1, float alpha) {
  return (alpha * (tex1 - tex0) + tex0);
}

void mainPS() {
    vec2 alphaCoord = v_ChunkCoords / 8.0;
    vec4 alphaBlend = texture(SAMPLER_2D(u_AlphaTexture0), alphaCoord);
    vec4 tex0 = texture(SAMPLER_2D(u_Texture0), v_ChunkCoords);
    vec4 tex1 = texture(SAMPLER_2D(u_Texture1), v_ChunkCoords);
    vec4 tex2 = texture(SAMPLER_2D(u_Texture2), v_ChunkCoords);
    vec4 tex3 = texture(SAMPLER_3D(u_Texture3), v_ChunkCoords);
    vec4 final = mixTex(mixTex(mixTex(tex0, tex1, alphaBlend.g), tex2, alphaBlend.b), tex3, alphaBlend.a);
    gl_FragColor = final * 2.0 * v_Color;
    gl_FragColor.a = 1.0;
}
#endif
`;
}

const modelBindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 2, numSamplers: 4 }, // ub_SceneParams
];


const MAX_DOODAD_INSTANCES = 32;

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
    Mat4x4 u_Transform[${MAX_DOODAD_INSTANCES}];
};

layout(binding = 0) uniform sampler2D u_Texture0;

varying vec2 v_UV;

#ifdef VERT
layout(location = ${ModelProgram.a_Position}) attribute vec3 a_Position;
layout(location = ${ModelProgram.a_Normal}) attribute vec3 a_Normal;
layout(location = ${ModelProgram.a_TexCoord}) attribute vec2 a_TexCoord;

void mainVS() {
    gl_Position = Mul(u_Projection, Mul(u_ModelView, Mul(u_Transform[gl_InstanceID], vec4(a_Position, 1.0))));
    v_UV = a_TexCoord;
}
#endif

#ifdef FRAG
void mainPS() {
    vec4 tex = texture(SAMPLER_2D(u_Texture0), v_UV);
    gl_FragColor = tex;
    if (tex.a < 0.2) {
      discard;
    }
}
#endif
`;
}

class ModelRenderer {
  private skinData: SkinData[] = [];
  private vertexBuffer: GfxVertexBufferDescriptor;
  private indexBuffers: GfxIndexBufferDescriptor[] = [];
  private inputLayout: GfxInputLayout;
  public visible: boolean = true;

  constructor(device: GfxDevice, public model: ModelData, renderHelper: GfxRenderHelper, private textureCache: TextureCache) {
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

    this.vertexBuffer = {
      buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, this.model.m2.get_vertex_data().buffer),
      byteOffset: 0,
    };

    for (let skin of this.model.skins) {
      const skinData = new SkinData(skin);
      this.indexBuffers.push({
        buffer: makeStaticDataBuffer(device, GfxBufferUsage.Index, skinData.indexBuffer.buffer),
        byteOffset: 0,
      });
      this.skinData.push(skinData);
    }
  }

  public isDrawable(): boolean {
    let nBatches = 0;
    for (let skinData of this.skinData) {
      nBatches += skinData.batches.length;
    }
    return nBatches > 0;
  }

  public prepareToRenderModelRenderer(renderInstManager: GfxRenderInstManager, numInstances: number): void {
    for (let i=0; i<this.skinData.length; i++) {
      const skinData = this.skinData[i];
      const indexBuffer = this.indexBuffers[i];
      for (let batch of skinData.batches) {
        let renderInst = renderInstManager.newRenderInst();
        renderInst.setVertexInput(this.inputLayout, [this.vertexBuffer], indexBuffer);
        const submesh = skinData.submeshes[batch.skin_submesh_index];
        renderInst.drawIndexesInstanced(submesh.index_count, numInstances, submesh.index_start);
        const m2TextureIndex = this.model.textureLookupTable[batch.texture_combo_index]; // FIXME handle more than 1 batch texture
        const blp = this.model.blps[m2TextureIndex];
        const blpId = this.model.blpIds[m2TextureIndex];
        const mapping = this.textureCache.getTextureMapping(blpId, blp);
        renderInst.setAllowSkippingIfPipelineNotReady(false);
        renderInst.setSamplerBindingsFromTextureMappings([mapping]);
        renderInstManager.submitRenderInst(renderInst);
      }
    }
  }
  
  public destroy(device: GfxDevice): void {
    device.destroyBuffer(this.vertexBuffer.buffer);
    for (let indexBuffer of this.indexBuffers) {
      device.destroyBuffer(indexBuffer.buffer);
    }
  }
}

class DoodadRenderer {
  public modelIdsToDoodads: Map<number, DoodadData[]>;
  public modelIdsToModelRenderers: Map<number, ModelRenderer>;

  constructor(device: GfxDevice, private textureCache: TextureCache, doodads: DoodadData[], models: Map<number, ModelData>, renderHelper: GfxRenderHelper) {
    this.modelIdsToDoodads = new Map();
    this.modelIdsToModelRenderers = new Map();
    for (let doodadData of doodads) {
      let doodadArray = this.modelIdsToDoodads.get(doodadData.modelId)
      if (doodadArray) {
        doodadArray.push(doodadData);
      } else {
        this.modelIdsToDoodads.set(doodadData.modelId, [doodadData]);
      }
    }

    for (let [modelId, doodads] of this.modelIdsToDoodads) {
      //console.log(`model ${modelId}: ${doodads.length} doodads`)
    }

    for (let modelId of this.modelIdsToDoodads.keys()) {
      const modelData = models.get(modelId);
      if (!modelData) {
        throw new Error(`couldn't find model with id ${modelId}`)
      }
      this.modelIdsToModelRenderers.set(modelId, new ModelRenderer(device, modelData, renderHelper, textureCache));
    }
  }

  public prepareToRenderDoodadRenderer(renderInstManager: GfxRenderInstManager, parentModelMatrix: mat4 | null): void {
    for (let [modelId, doodads] of this.modelIdsToDoodads) {
      const modelRenderer = this.modelIdsToModelRenderers.get(modelId)!;
      if (!modelRenderer.isDrawable()) continue;

      const visibleDoodads = doodads.filter(d => d.visible);

      const template = renderInstManager.pushTemplateRenderInst();

      for (let doodads of chunk(visibleDoodads, MAX_DOODAD_INSTANCES)) {
        let offs = template.allocateUniformBuffer(ModelProgram.ub_ModelParams, 16 * MAX_DOODAD_INSTANCES);
        const mapped = template.mapUniformBufferF32(ModelProgram.ub_ModelParams);
        for (let doodad of doodads) {
          if (parentModelMatrix) {
            const combinedModelMatrix = mat4.mul(mat4.create(), parentModelMatrix, doodad.modelMatrix);
            offs += fillMatrix4x4(mapped, offs, combinedModelMatrix);
          } else {
            offs += fillMatrix4x4(mapped, offs, doodad.modelMatrix);
          }
        }
        modelRenderer.prepareToRenderModelRenderer(renderInstManager, doodads.length);
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

function chunk<T>(arr: T[], chunkSize: number): T[][] {
  const ret: T[][] = [];
  for (let i = 0; i < arr.length; i += chunkSize)
      ret.push(arr.slice(i, i + chunkSize));
  return ret;
}

class WmoStructureRenderer {
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
        mappings.push(this.textureCache.getAllWhiteTextureMapping());
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

  public prepareToRenderWmoStructure(renderInstManager: GfxRenderInstManager) {
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
    for (let i=0; i<this.vertexBuffers.length; i++) {
      this.vertexBuffers[i].forEach(buf => device.destroyBuffer(buf.buffer));
      device.destroyBuffer(this.indexBuffers[i].buffer);
    }
  }
}

class WmoRenderer {
  public wmoProgram: GfxProgram;
  public modelProgram: GfxProgram;
  public wmoIdToRenderer: Map<number, WmoStructureRenderer>;
  public wmoIdToModelRenderer: Map<number, DoodadRenderer>;
  public wmoIdToWmoDefs: Map<number, WmoDefinition[]>;
  public wmoIdToVisible: Map<number, boolean>;

  constructor(device: GfxDevice, wmoDefs: WmoDefinition[], wmos: WmoData[], textureCache: TextureCache, renderHelper: GfxRenderHelper) {
    this.wmoProgram = renderHelper.renderCache.createProgram(new WmoProgram());
    this.modelProgram = renderHelper.renderCache.createProgram(new ModelProgram());
    this.wmoIdToRenderer = new Map();
    this.wmoIdToModelRenderer = new Map();
    this.wmoIdToWmoDefs = new Map();

    for (let wmoDef of wmoDefs) {
      let defs = this.wmoIdToWmoDefs.get(wmoDef.wmoId);
      if (defs) {
        defs.push(wmoDef);
      } else {
        this.wmoIdToWmoDefs.set(wmoDef.wmoId, [wmoDef]);
      }
    }

    for (let wmo of wmos) {
      this.wmoIdToRenderer.set(wmo.fileId, new WmoStructureRenderer(device, wmo, textureCache, renderHelper));
      const doodads = wmo.wmo.doodad_defs.map(def => DoodadData.fromWmoDoodad(def, wmo));
      this.wmoIdToModelRenderer.set(wmo.fileId, new DoodadRenderer(device, textureCache, doodads, wmo.models, renderHelper));
    }
  }

  public setCulling(viewerInput: Viewer.ViewerRenderInput) {
    const cameraPosition: vec3 = [0, 0, 0];
    getMatrixTranslation(cameraPosition, viewerInput.camera.worldMatrix);
    for (let wmoDefs of this.wmoIdToWmoDefs.values()) {
      for (let def of wmoDefs) {
        let distance = computeViewSpaceDepthFromWorldSpaceAABB(viewerInput.camera.viewMatrix, def.worldSpaceAABB);
        const isCloseEnough = distance < MAX_WMO_RENDER_DIST;
        def.visible = viewerInput.camera.frustum.contains(def.worldSpaceAABB) && isCloseEnough;
        def.doodadsVisible = def.worldSpaceAABB.containsPoint(cameraPosition);
      }
    }
  }

  public prepareToRenderWmoRenderer(renderInstManager: GfxRenderInstManager) {
    const cam = mat4.create();
    mat4.mul(cam, window.main.viewer.camera.clipFromWorldMatrix, noclipSpaceFromAdtSpace);
    const template = renderInstManager.pushTemplateRenderInst();
    template.setGfxProgram(this.wmoProgram);
    template.setBindingLayouts(wmoBindingLayouts);
    for (let [wmoId, wmoDefs] of this.wmoIdToWmoDefs.entries()) {
      let renderer = this.wmoIdToRenderer.get(wmoId)!;
      for (let def of wmoDefs) {
        if (!def.visible) continue;
        let offs = template.allocateUniformBuffer(ModelProgram.ub_ModelParams, 16);
        const mapped = template.mapUniformBufferF32(ModelProgram.ub_ModelParams);
        offs += fillMatrix4x4(mapped, offs, def.modelMatrix);
        renderer.prepareToRenderWmoStructure(renderInstManager);
      }
    }

    template.setGfxProgram(this.modelProgram);
    template.setBindingLayouts(modelBindingLayouts);
    for (let [wmoId, wmoDefs] of this.wmoIdToWmoDefs.entries()) {
      let renderer = this.wmoIdToModelRenderer.get(wmoId)!;
      for (let def of wmoDefs) {
        if (!def.doodadsVisible) continue;
        renderer.prepareToRenderDoodadRenderer(renderInstManager, def.modelMatrix);
      }
    }

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

interface VisibleGuy {
  visible: boolean;
  data: any;
}

class AdtTerrainRenderer {
  private inputLayout: GfxInputLayout;
  public indexBuffer: GfxIndexBufferDescriptor;
  public vertexBuffer: GfxVertexBufferDescriptor;
  public adtChunks: WowAdtChunkDescriptor[] = [];
  public alphaTextureMappings: (TextureMapping | null)[] = [];
  public chunkVisible: VisibleGuy[] = [];
  public worldSpaceAABB: AABB;
  public visible: boolean = true;

  constructor(device: GfxDevice, renderHelper: GfxRenderHelper, public adt: AdtData, private textureCache: TextureCache) {
    const adtVboInfo = rust.WowAdt.get_vbo_info();
    const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
      { location: TerrainProgram.a_ChunkIndex, bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_R },
      { location: TerrainProgram.a_Position,   bufferIndex: 0, bufferByteOffset: adtVboInfo.vertex_offset, format: GfxFormat.F32_RGB, },
      { location: TerrainProgram.a_Normal,     bufferIndex: 0, bufferByteOffset: adtVboInfo.normal_offset, format: GfxFormat.F32_RGB, },
      { location: TerrainProgram.a_Color,      bufferIndex: 0, bufferByteOffset: adtVboInfo.color_offset, format: GfxFormat.F32_RGBA, },
    ];
    const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
      { byteStride: adtVboInfo.stride, frequency: GfxVertexBufferFrequency.PerVertex },
    ];
    const indexBufferFormat: GfxFormat = GfxFormat.U16_R;
    const cache = renderHelper.renderCache;
    this.inputLayout = cache.createInputLayout({ vertexAttributeDescriptors, vertexBufferDescriptors, indexBufferFormat });
    [this.vertexBuffer, this.indexBuffer, this.adtChunks, this.worldSpaceAABB] = this.adt.getBufsAndChunks(device);
    for (let chunk of this.adtChunks) {
      const alphaTex = chunk.alpha_texture;
      this.chunkVisible.push({
        visible: true,
        data: {
          alphaTex: alphaTex,
          chunk: chunk,
        }
      });
      if (alphaTex) {
        this.alphaTextureMappings.push(textureCache.getAlphaTextureMapping(device, alphaTex));
      } else {
        this.alphaTextureMappings.push(textureCache.getAllBlackTextureMapping());
      }
    }
  }

  public setCulling(viewerInput: Viewer.ViewerRenderInput) {
    let distance = computeViewSpaceDepthFromWorldSpaceAABB(viewerInput.camera.viewMatrix, this.worldSpaceAABB);
    const isCloseEnough = distance < MAX_ADT_RENDER_DIST;
    this.visible = viewerInput.camera.frustum.contains(this.worldSpaceAABB) && isCloseEnough;
  }

  private getChunkTextureMapping(chunk: WowAdtChunkDescriptor): (TextureMapping | null)[] {
    let mapping: (TextureMapping | null)[] = [
      null, null, null, null
    ];
    chunk.texture_layers.forEach((textureFileId, i) => {
      const blp = this.adt.blps.get(textureFileId);
      if (!blp) {
        throw new Error(`couldn't find matching blp for fileID ${textureFileId}`);
      }
      mapping[i] = this.textureCache.getTextureMapping(textureFileId, blp);
    })
    return mapping;
  }

  public prepareToRenderAdtTerrain(renderInstManager: GfxRenderInstManager) {
    if (!this.visible) return;
    const template = renderInstManager.pushTemplateRenderInst();
    template.setVertexInput(this.inputLayout, [this.vertexBuffer], this.indexBuffer);
    this.adtChunks.forEach((chunk, i) => {
      if (this.chunkVisible[i].visible && chunk.index_count > 0) {
        const renderInst = renderInstManager.newRenderInst();
        const textureMapping = this.getChunkTextureMapping(chunk);
        textureMapping.push(this.alphaTextureMappings[i])
        renderInst.setSamplerBindingsFromTextureMappings(textureMapping);
        renderInst.drawIndexes(chunk.index_count, chunk.index_offset);
        renderInstManager.submitRenderInst(renderInst);
      }
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
  private modelRenderers: DoodadRenderer[] = [];
  private wmoRenderers: WmoRenderer[] = [];
  private terrainProgram: GfxProgram;
  private modelProgram: GfxProgram;

  constructor(device: GfxDevice, public world: WorldData, public textureHolder: DebugTexHolder, public renderHelper: GfxRenderHelper) {
    const textureCache = new TextureCache(this.renderHelper.renderCache);
    this.terrainProgram = this.renderHelper.renderCache.createProgram(new TerrainProgram());
    this.modelProgram = this.renderHelper.renderCache.createProgram(new ModelProgram());

    if (this.world.globalWmo) {
      this.wmoRenderers.push(new WmoRenderer(device,
        [this.world.globalWmoDef!],
        [this.world.globalWmo],
        textureCache,
        this.renderHelper
      ));
    } else {
      for (let adt of this.world.adts) {
        this.terrainRenderers.push(new AdtTerrainRenderer(device, this.renderHelper, adt, textureCache));
        const adtDoodads = adt.innerAdt.doodads.map(DoodadData.fromAdtDoodad);
        this.modelRenderers.push(new DoodadRenderer(device, textureCache, adtDoodads, adt.models, renderHelper));
        this.wmoRenderers.push(new WmoRenderer(
          device,
          adt.wmoDefs,
          Array.from(adt.wmos.values()),
          textureCache,
          this.renderHelper
        ));
      }
    }
  }

  private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
    const template = this.renderHelper.pushTemplateRenderInst();
    template.setBindingLayouts(terrainBindingLayouts);
    template.setGfxProgram(this.terrainProgram)
    template.setMegaStateFlags({ cullMode: GfxCullMode.Back });

    let offs = template.allocateUniformBuffer(ModelProgram.ub_SceneParams, 32);
    const mapped = template.mapUniformBufferF32(ModelProgram.ub_SceneParams);
    offs += fillMatrix4x4(mapped, offs, viewerInput.camera.projectionMatrix);
    const viewMat = mat4.create();
    mat4.mul(viewMat, viewerInput.camera.viewMatrix, noclipSpaceFromAdtSpace);
    offs += fillMatrix4x4(mapped, offs, viewMat);

    this.terrainRenderers.forEach(terrainRenderer => {
      terrainRenderer.setCulling(viewerInput);
      terrainRenderer.prepareToRenderAdtTerrain(this.renderHelper.renderInstManager);
    });

    template.setBindingLayouts(modelBindingLayouts);
    template.setGfxProgram(this.modelProgram);
    this.modelRenderers.forEach(modelRenderer => {
      modelRenderer.prepareToRenderDoodadRenderer(this.renderHelper.renderInstManager, null);
    });

    this.wmoRenderers.forEach(wmoRenderer => {
      if (!this.world.globalWmo)
        wmoRenderer.setCulling(viewerInput)
      wmoRenderer.prepareToRenderWmoRenderer(this.renderHelper.renderInstManager);
    });

    this.renderHelper.renderInstManager.popTemplateRenderInst();
    this.renderHelper.prepareToRender();
  }

  public adjustCameraController(c: CameraController) {
      c.setSceneMoveSpeedMult(.1);
  }

  render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
    viewerInput.camera.setClipPlanes(0.1);
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
    new WdtSceneDesc("Blackrock Depths", 780172),
    new WdtSceneDesc("Upper Blackrock Spire", 1101201),
    new WdtSceneDesc("Deadmines", 780605),
    new WdtSceneDesc("Shadowfang Keep", 790796),
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs, hidden: false };
