import * as Viewer from '../viewer.js';
import { SceneContext } from '../SceneBase.js';
import { rust } from '../rustlib.js';
import { WowM2, WowSkin, WowBlp, WowPixelFormat, WowWdt, WowAdt, WowAdtChunkDescriptor, WowDoodad, WowSkinSubmesh, WowModelBatch, WowAdtWmoDefinition } from '../../rust/pkg/index.js';
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
import { ModelData, SkinData, AdtData, WorldData, DoodadData, WmoData, WmoBatchData, WmoDefinition, LazyWorldData, WowCache } from './data.js';
import { getMatrixTranslation } from "../MathHelpers.js";
import { fetchFileByID, fetchDataByFileID, initFileList, getFilePath } from "./util.js";
import { CameraController, computeViewSpaceDepthFromWorldSpaceAABB } from '../Camera.js';
import { TextureListHolder, Panel } from '../ui.js';
import { GfxTopology, convertToTriangleIndexBuffer } from '../gfx/helpers/TopologyHelpers.js';
import { drawWorldSpaceAABB, drawWorldSpaceText, getDebugOverlayCanvas2D, interactiveVizSliderSelect } from '../DebugJunk.js';
import { AABB } from '../Geometry.js';
import { ModelProgram, MAX_DOODAD_INSTANCES, WmoProgram, TerrainProgram } from './program.js';
import { ViewerRenderInput } from '../viewer.js';

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

class ModelRenderer {
  private skinData: SkinData[] = [];
  private vertexBuffer: GfxVertexBufferDescriptor;
  private indexBuffers: GfxIndexBufferDescriptor[] = [];
  private inputLayout: GfxInputLayout;
  public visible: boolean = true;

  constructor(device: GfxDevice, public model: ModelData, renderHelper: GfxRenderHelper, private textureCache: TextureCache, private wowCache: WowCache) {
    const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
      { location: ModelProgram.a_Position, bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_RGB, },
      { location: ModelProgram.a_Normal,   bufferIndex: 0, bufferByteOffset: 20, format: GfxFormat.F32_RGB, },
      { location: ModelProgram.a_TexCoord0, bufferIndex: 0, bufferByteOffset: 32, format: GfxFormat.F32_RG, },
      { location: ModelProgram.a_TexCoord1, bufferIndex: 0, bufferByteOffset: 40, format: GfxFormat.F32_RG, },
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
      const skinData = new SkinData(skin, this.model);
      this.indexBuffers.push({
        buffer: makeStaticDataBuffer(device, GfxBufferUsage.Index, skinData.indexBuffer.buffer),
        byteOffset: 0,
      });
      this.skinData.push(skinData);
    }
  }

  public update(viewer: ViewerRenderInput) {
    if (this.visible)
      this.model.updateAnimation(viewer.deltaTime);
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
      for (let renderPass of skinData.renderPasses) {
        let renderInst = renderInstManager.newRenderInst();
        renderInst.setVertexInput(this.inputLayout, [this.vertexBuffer], indexBuffer);
        renderPass.setMegaStateFlags(renderInst);
        renderInst.drawIndexesInstanced(renderPass.submesh.index_count, numInstances, renderPass.submesh.index_start);
        const mappings = [renderPass.tex0, renderPass.tex1, renderPass.tex2, renderPass.tex3]
          .map(tex => tex === null ? null : this.textureCache.getTextureMapping(tex, this.wowCache.blps.get(tex)!));
        renderInst.setAllowSkippingIfPipelineNotReady(false);
        renderInst.setSamplerBindingsFromTextureMappings(mappings);
        renderPass.setModelParams(renderInst);
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

  constructor(device: GfxDevice, private textureCache: TextureCache, doodads: DoodadData[], renderHelper: GfxRenderHelper, private wowCache: WowCache) {
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

    for (let modelId of this.modelIdsToDoodads.keys()) {
      const modelData = wowCache.models.get(modelId);
      if (!modelData) {
        throw new Error(`couldn't find model with id ${modelId}`)
      }
      this.modelIdsToModelRenderers.set(modelId, new ModelRenderer(device, modelData, renderHelper, textureCache, wowCache));
    }
  }

  public update(viewer: ViewerRenderInput) {
    for (let modelRenderer of this.modelIdsToModelRenderers.values()) {
      modelRenderer.update(viewer);
    }
  }

  public prepareToRenderDoodadRenderer(renderInstManager: GfxRenderInstManager, parentModelMatrix: mat4 | null): void {
    for (let [modelId, doodads] of this.modelIdsToDoodads) {
      const modelRenderer = this.modelIdsToModelRenderers.get(modelId)!;
      if (!modelRenderer.isDrawable() || !modelRenderer.visible) continue;

      const visibleDoodads = doodads.filter(d => d.visible);

      const template = renderInstManager.pushTemplateRenderInst();

      for (let doodads of chunk(visibleDoodads, MAX_DOODAD_INSTANCES)) {
        let offs = template.allocateUniformBuffer(ModelProgram.ub_DoodadParams, 16 * MAX_DOODAD_INSTANCES);
        const mapped = template.mapUniformBufferF32(ModelProgram.ub_DoodadParams);
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

  constructor(device: GfxDevice, private wmo: WmoData, private textureCache: TextureCache, renderHelper: GfxRenderHelper, private wowCache: WowCache) {
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

    for (let groupId of wmo.groupIds) {
      const group = wowCache.wmoGroups.get(groupId)!;
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
        const blp = this.wowCache.blps.get(blpId)!;
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
  public wmoIdToStructureRenderer: Map<number, WmoStructureRenderer>;
  public wmoIdToDoodadRenderer: Map<number, DoodadRenderer>;
  public wmoIdToWmoDefs: Map<number, WmoDefinition[]>;
  public wmoIdToVisible: Map<number, boolean>;

  constructor(device: GfxDevice, wmoDefs: WmoDefinition[], wmoIds: number[], textureCache: TextureCache, renderHelper: GfxRenderHelper, private wowCache: WowCache) {
    this.wmoProgram = renderHelper.renderCache.createProgram(new WmoProgram());
    this.modelProgram = renderHelper.renderCache.createProgram(new ModelProgram());
    this.wmoIdToStructureRenderer = new Map();
    this.wmoIdToDoodadRenderer = new Map();
    this.wmoIdToWmoDefs = new Map();

    for (let wmoDef of wmoDefs) {
      let defs = this.wmoIdToWmoDefs.get(wmoDef.wmoId);
      if (defs) {
        defs.push(wmoDef);
      } else {
        this.wmoIdToWmoDefs.set(wmoDef.wmoId, [wmoDef]);
      }
    }

    for (let wmoId of this.wmoIdToWmoDefs.keys()) {
      const wmo = wowCache.wmos.get(wmoId)!;
      this.wmoIdToStructureRenderer.set(wmo.fileId, new WmoStructureRenderer(device, wmo, textureCache, renderHelper, wowCache));
      const doodads = wmo.wmo.doodad_defs.map(def => DoodadData.fromWmoDoodad(def, wmo));
      this.wmoIdToDoodadRenderer.set(wmo.fileId, new DoodadRenderer(device, textureCache, doodads, renderHelper, wowCache));
    }
  }

  public update(viewer: ViewerRenderInput) {
    for (let doodadRenderer of this.wmoIdToDoodadRenderer.values()) {
      doodadRenderer.update(viewer);
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
    template.setBindingLayouts(WmoProgram.bindingLayouts);
    for (let [wmoId, wmoDefs] of this.wmoIdToWmoDefs.entries()) {
      let renderer = this.wmoIdToStructureRenderer.get(wmoId)!;
      for (let def of wmoDefs) {
        if (!def.visible) continue;
        let offs = template.allocateUniformBuffer(ModelProgram.ub_DoodadParams, 16);
        const mapped = template.mapUniformBufferF32(ModelProgram.ub_DoodadParams);
        offs += fillMatrix4x4(mapped, offs, def.modelMatrix);
        renderer.prepareToRenderWmoStructure(renderInstManager);
      }
    }

    template.setGfxProgram(this.modelProgram);
    template.setBindingLayouts(ModelProgram.bindingLayouts);
    for (let [wmoId, wmoDefs] of this.wmoIdToWmoDefs.entries()) {
      let renderer = this.wmoIdToDoodadRenderer.get(wmoId)!;
      for (let def of wmoDefs) {
        if (!def.doodadsVisible) continue;
        renderer.prepareToRenderDoodadRenderer(renderInstManager, def.modelMatrix);
      }
    }

    renderInstManager.popTemplateRenderInst();
  }

  public destroy(device: GfxDevice) {
    for (let renderer of this.wmoIdToDoodadRenderer.values()) {
      renderer.destroy(device);
    }
    for (let renderer of this.wmoIdToStructureRenderer.values()) {
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

  constructor(device: GfxDevice, renderHelper: GfxRenderHelper, public adt: AdtData, private textureCache: TextureCache, private wowCache: WowCache) {
    const adtVboInfo = rust.WowAdt.get_vbo_info();
    const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
      { location: TerrainProgram.a_ChunkIndex, bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_R },
      { location: TerrainProgram.a_Position,   bufferIndex: 0, bufferByteOffset: adtVboInfo.vertex_offset, format: GfxFormat.F32_RGB, },
      { location: TerrainProgram.a_Normal,     bufferIndex: 0, bufferByteOffset: adtVboInfo.normal_offset, format: GfxFormat.F32_RGB, },
      { location: TerrainProgram.a_Color,      bufferIndex: 0, bufferByteOffset: adtVboInfo.color_offset, format: GfxFormat.F32_RGBA, },
      { location: TerrainProgram.a_Lighting,   bufferIndex: 0, bufferByteOffset: adtVboInfo.lighting_offset, format: GfxFormat.F32_RGBA, },
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
      const blp = this.wowCache.blps.get(textureFileId);
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
  private doodadRenderers: DoodadRenderer[] = [];
  private wmoRenderers: WmoRenderer[] = [];
  private terrainProgram: GfxProgram;
  private modelProgram: GfxProgram;

  constructor(device: GfxDevice, public world: WorldData, public textureHolder: DebugTexHolder, public renderHelper: GfxRenderHelper, private wowCache: WowCache) {
    const textureCache = new TextureCache(this.renderHelper.renderCache);
    this.terrainProgram = this.renderHelper.renderCache.createProgram(new TerrainProgram());
    this.modelProgram = this.renderHelper.renderCache.createProgram(new ModelProgram());

    if (this.world.globalWmo) {
      this.wmoRenderers.push(new WmoRenderer(device,
        [this.world.globalWmoDef!],
        [this.world.globalWmo.fileId],
        textureCache,
        this.renderHelper,
        wowCache
      ));
    } else {
      for (let adt of this.world.adts) {
        this.terrainRenderers.push(new AdtTerrainRenderer(device, this.renderHelper, adt, textureCache, wowCache));
        const adtDoodads = adt.innerAdt.doodads.map(DoodadData.fromAdtDoodad);
        this.doodadRenderers.push(new DoodadRenderer(device, textureCache, adtDoodads, renderHelper, wowCache));
        this.wmoRenderers.push(new WmoRenderer(
          device,
          adt.wmoDefs,
          adt.wmoIds,
          textureCache,
          this.renderHelper,
          wowCache
        ));
      }
    }
  }

  public update(viewer: ViewerRenderInput) {
    for (let doodadRenderer of this.doodadRenderers) {
      doodadRenderer.update(viewer);
    }
  }

  public debugModelRenderers() {
    const modelRenderers: ModelRenderer[] = [];
    this.wmoRenderers.forEach(d => {
      for (let r of d.wmoIdToDoodadRenderer.values()) {
        for (let m of r.modelIdsToModelRenderers.values()) {
          modelRenderers.push(m);
        }
      }
    })
    this.doodadRenderers.forEach(d => {
      for (let m of d.modelIdsToModelRenderers.values()) {
        modelRenderers.push(m);
      }
    })

    interactiveVizSliderSelect(modelRenderers);
  }

  private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
    const template = this.renderHelper.pushTemplateRenderInst();
    template.setBindingLayouts(TerrainProgram.bindingLayouts);
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

    template.setBindingLayouts(ModelProgram.bindingLayouts);
    template.setGfxProgram(this.modelProgram);
    this.doodadRenderers.forEach(doodadRenderer => {
      doodadRenderer.update(viewerInput);
      doodadRenderer.prepareToRenderDoodadRenderer(this.renderHelper.renderInstManager, null);
    });

    this.wmoRenderers.forEach(wmoRenderer => {
      if (!this.world.globalWmo)
        wmoRenderer.setCulling(viewerInput)
      wmoRenderer.update(viewerInput);
      wmoRenderer.prepareToRenderWmoRenderer(this.renderHelper.renderInstManager);
    });

    this.renderHelper.renderInstManager.popTemplateRenderInst();
    this.renderHelper.prepareToRender();
  }

  public adjustCameraController(c: CameraController) {
      c.setSceneMoveSpeedMult(0.51);
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
    this.doodadRenderers.forEach(modelRenderer => {
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
    const cache = new WowCache(dataFetcher);
    const renderHelper = new GfxRenderHelper(device);
    await initFileList(dataFetcher);
    rust.init_panic_hook();
    const wdt = new WorldData(this.fileId);
    console.time('loading wdt');
    await wdt.load(dataFetcher, cache);
    console.timeEnd('loading wdt');
    const holder = new DebugTexHolder();
    let entries: DebugTex[] = [];
    for (let adt of wdt.adts) {
      for (let blpId of adt.blpIds) {
        const blp = cache.blps.get(blpId)!;
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
    return new WorldScene(device, wdt, holder, renderHelper, cache);
  }
}

class ContinentScene implements Viewer.SceneGfx {
  private terrainRenderers: AdtTerrainRenderer[] = [];
  private doodadRenderers: DoodadRenderer[] = [];
  private wmoRenderers: WmoRenderer[] = [];
  private terrainProgram: GfxProgram;
  private modelProgram: GfxProgram;

  constructor(device: GfxDevice, public world: LazyWorldData, public renderHelper: GfxRenderHelper, private wowCache: WowCache) {
    const textureCache = new TextureCache(this.renderHelper.renderCache);
    this.terrainProgram = this.renderHelper.renderCache.createProgram(new TerrainProgram());
    this.modelProgram = this.renderHelper.renderCache.createProgram(new ModelProgram());

    for (let adt of this.world.adts) {
      this.terrainRenderers.push(new AdtTerrainRenderer(device, this.renderHelper, adt, textureCache, wowCache));
      const adtDoodads = adt.innerAdt.doodads.map(DoodadData.fromAdtDoodad);
      this.doodadRenderers.push(new DoodadRenderer(device, textureCache, adtDoodads, renderHelper, wowCache));
      this.wmoRenderers.push(new WmoRenderer(
        device,
        adt.wmoDefs,
        adt.wmoIds,
        textureCache,
        this.renderHelper,
        wowCache,
      ));
    }
  }

  public update(viewer: ViewerRenderInput) {
    for (let doodadRenderer of this.doodadRenderers) {
      doodadRenderer.update(viewer);
    }
  }

  public debugModelRenderers() {
    const modelRenderers: ModelRenderer[] = [];
    this.wmoRenderers.forEach(d => {
      for (let r of d.wmoIdToDoodadRenderer.values()) {
        for (let m of r.modelIdsToModelRenderers.values()) {
          modelRenderers.push(m);
        }
      }
    })
    this.doodadRenderers.forEach(d => {
      for (let m of d.modelIdsToModelRenderers.values()) {
        modelRenderers.push(m);
      }
    })

    interactiveVizSliderSelect(modelRenderers);
  }

  private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
    const template = this.renderHelper.pushTemplateRenderInst();
    template.setBindingLayouts(TerrainProgram.bindingLayouts);
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

    template.setBindingLayouts(ModelProgram.bindingLayouts);
    template.setGfxProgram(this.modelProgram);
    this.doodadRenderers.forEach(doodadRenderer => {
      doodadRenderer.update(viewerInput);
      doodadRenderer.prepareToRenderDoodadRenderer(this.renderHelper.renderInstManager, null);
    });

    this.wmoRenderers.forEach(wmoRenderer => {
      if (!this.world.globalWmo)
        wmoRenderer.setCulling(viewerInput)
      wmoRenderer.update(viewerInput);
      wmoRenderer.prepareToRenderWmoRenderer(this.renderHelper.renderInstManager);
    });

    this.renderHelper.renderInstManager.popTemplateRenderInst();
    this.renderHelper.prepareToRender();
  }

  public adjustCameraController(c: CameraController) {
    c.setSceneMoveSpeedMult(0.01);
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
    this.doodadRenderers.forEach(modelRenderer => {
      modelRenderer.destroy(device);
    })
    this.wmoRenderers.forEach(wmoRenderer => {
      wmoRenderer.destroy(device);
    })
  }
}

class ContinentSceneDesc implements Viewer.SceneDesc {
  public id: string;

  constructor(public name: string, public fileId: number, public startX: number, public startY: number) {
    this.id = `${name}-${fileId}-${startX}-${startY}`;
  }

  public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
    const dataFetcher = context.dataFetcher;
    const cache = new WowCache(dataFetcher);
    const renderHelper = new GfxRenderHelper(device);
    await initFileList(dataFetcher);
    rust.init_panic_hook();
    const wdt = new LazyWorldData(this.fileId, [this.startX, this.startY], 1);
    console.time('loading wdt')
    await wdt.load(dataFetcher, cache);
    console.timeEnd('loading wdt')
    return new ContinentScene(device, wdt, renderHelper, cache);
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

    "Kalimdor",
    new ContinentSceneDesc("??", 782779, 35, 23),
    
    "Eastern Kingdoms",
    new ContinentSceneDesc("Undercity", 775971, 31, 28),
    new ContinentSceneDesc("Stormwind", 775971, 31, 48),
    new ContinentSceneDesc("Ironforge", 775971, 33, 40),
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs, hidden: false };
