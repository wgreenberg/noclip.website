import { mat4, vec4 } from "gl-matrix";
import { drawWorldSpaceAABB, getDebugOverlayCanvas2D } from "../DebugJunk.js";
import { AABB } from "../Geometry.js";
import { TextureMapping } from "../TextureHolder.js";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers.js";
import { fillMatrix4x4, fillVec4, fillVec4v } from "../gfx/helpers/UniformBufferHelpers.js";
import { GfxVertexBufferDescriptor, GfxIndexBufferDescriptor, GfxDevice, GfxVertexAttributeDescriptor, GfxInputLayoutBufferDescriptor, GfxVertexBufferFrequency, GfxBufferUsage } from "../gfx/platform/GfxPlatform.js";
import { GfxFormat } from "../gfx/platform/GfxPlatformFormat.js";
import { GfxInputLayout, GfxProgram } from "../gfx/platform/GfxPlatformImpl.js";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper.js";
import { GfxRenderInstManager } from "../gfx/render/GfxRenderInstManager.js";
import { rust } from "../rustlib.js";
import { ViewerRenderInput } from "../viewer.js";
import { SkinData, ModelData, WmoBatchData, WmoData, WmoDefinition, WmoGroupData, AdtData, DoodadData, ModelRenderPass, ChunkData } from "./data.js";
import { MAX_DOODAD_INSTANCES, ModelProgram, SkyboxProgram, TerrainProgram, WmoProgram } from "./program.js";
import { TextureCache } from "./tex.js";
import { WowAdtChunkDescriptor } from "../../rust/pkg/index.js";
import { adtSpaceFromPlacementSpace, noclipSpaceFromAdtSpace, placementSpaceFromModelSpace } from "./scenes.js";
import { convertToTriangleIndexBuffer, GfxTopology } from "../gfx/helpers/TopologyHelpers.js";
import { skyboxVertices, skyboxIndices } from "./skybox.js";
import { assert } from "../util.js";

type TextureMappingArray = (TextureMapping | null)[];

export class ModelRenderer {
  private skinData: SkinData[] = [];
  private vertexBuffer: GfxVertexBufferDescriptor;
  private indexBuffers: GfxIndexBufferDescriptor[] = [];
  private skinPassTextures: TextureMappingArray[][] = [];
  private inputLayout: GfxInputLayout;

  constructor(device: GfxDevice, public model: ModelData, renderHelper: GfxRenderHelper, private textureCache: TextureCache) {
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
      buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, this.model.m2.vertex_data.buffer),
      byteOffset: 0,
    };

    for (let i in this.model.skins) {
      const skin = this.model.skins[i];
      const skinData = new SkinData(skin, this.model);
      this.indexBuffers.push({
        buffer: makeStaticDataBuffer(device, GfxBufferUsage.Index, skinData.indexBuffer.buffer),
        byteOffset: 0,
      });
      this.skinData.push(skinData);
      this.skinPassTextures[i] = [];
      for (let renderPass of skinData.renderPasses) {
        this.skinPassTextures[i].push(this.getRenderPassTextures(renderPass));
      }
    }
  }

  public update(viewer: ViewerRenderInput) {
    this.model.updateAnimation(viewer.deltaTime);
  }

  public isDrawable(): boolean {
    let nBatches = 0;
    for (let skinData of this.skinData) {
      nBatches += skinData.batches.length;
    }
    return nBatches > 0;
  }

  private getRenderPassTextures(renderPass: ModelRenderPass): TextureMappingArray {
    return [renderPass.tex0, renderPass.tex1, renderPass.tex2, renderPass.tex3]
      .map(blp => blp === null ? null : this.textureCache.getTextureMapping(blp.fileId, blp.inner));
  }

  public prepareToRenderModel(renderInstManager: GfxRenderInstManager, doodads: DoodadData[]): void {
    if (!this.isDrawable()) return;

    const visibleDoodads = doodads.filter(d => d.visible);

    for (let doodadChunk of chunk(visibleDoodads, MAX_DOODAD_INSTANCES)) {
      const template = renderInstManager.pushTemplateRenderInst();
      let offs = template.allocateUniformBuffer(ModelProgram.ub_DoodadParams, (16 + 4 * 3) * MAX_DOODAD_INSTANCES);
      const mapped = template.mapUniformBufferF32(ModelProgram.ub_DoodadParams);
      for (let doodad of doodadChunk) {
        offs += fillMatrix4x4(mapped, offs, doodad.modelMatrix);
        offs += fillVec4v(mapped, offs, doodad.ambientColor);
        offs += fillVec4v(mapped, offs, [0, 0, 0, 0]);
        offs += fillVec4(mapped, offs,
          doodad.applyInteriorLighting ? 1.0 : 0.0,
          doodad.applyExteriorLighting ? 1.0 : 0.0,
          doodad.applyInteriorLighting ? 1.0 : 0.0,
          0
        );
      }

      for (let i=0; i<this.skinData.length; i++) {
        const skinData = this.skinData[i];
        const indexBuffer = this.indexBuffers[i];
        for (let j in skinData.renderPasses) {
          const renderPass = skinData.renderPasses[j];
          let renderInst = renderInstManager.newRenderInst();
          renderInst.setVertexInput(this.inputLayout, [this.vertexBuffer], indexBuffer);
          renderPass.setMegaStateFlags(renderInst);
          renderInst.drawIndexesInstanced(renderPass.submesh.index_count, doodadChunk.length, renderPass.submesh.index_start);
          const mappings = this.skinPassTextures[i][j];
          renderInst.setAllowSkippingIfPipelineNotReady(false);
          renderInst.setSamplerBindingsFromTextureMappings(mappings);
          renderPass.setModelParams(renderInst);
          renderInstManager.submitRenderInst(renderInst);
        }
      }
      renderInstManager.popTemplateRenderInst();
    }
  }
  
  public destroy(device: GfxDevice): void {
    device.destroyBuffer(this.vertexBuffer.buffer);
    for (let indexBuffer of this.indexBuffers) {
      device.destroyBuffer(indexBuffer.buffer);
    }
  }
}

function chunk<T>(arr: T[], chunkSize: number): T[][] {
  const ret: T[][] = [];
  for (let i = 0; i < arr.length; i += chunkSize)
      ret.push(arr.slice(i, i + chunkSize));
  return ret;
}

export class WmoRenderer {
  private inputLayouts: GfxInputLayout[] = [];
  private vertexBuffers: GfxVertexBufferDescriptor[][] = [];
  private indexBuffers: GfxIndexBufferDescriptor[] = [];
  private groups: WmoGroupData[] = [];
  public batches: WmoBatchData[][] = [];
  public groupBatchTextureMappings: TextureMappingArray[][] = [];

  constructor(device: GfxDevice, private wmo: WmoData, private textureCache: TextureCache, renderHelper: GfxRenderHelper) {
    for (let group of this.wmo.groups) {
      this.inputLayouts.push(group.getInputLayout(renderHelper.renderCache));
      this.vertexBuffers.push(group.getVertexBuffers(device));
      this.indexBuffers.push(group.getIndexBuffer(device));
      this.batches.push(group.getBatches(this.wmo));
      this.groups.push(group);
    }
    for (let i in this.batches) {
      const batches = this.batches[i];
      this.groupBatchTextureMappings[i] = [];
      for (let batch of batches) {
        this.groupBatchTextureMappings[i].push(this.getBatchTextureMapping(batch));
      }
    }
  }

  private getBatchTextureMapping(batch: WmoBatchData): TextureMappingArray {
    const mappings = []
    for (let blp of batch.textures) {
      if (blp === null) {
        mappings.push(this.textureCache.getAllWhiteTextureMapping());
      } else {
        const wrap = !(batch.materialFlags.clamp_s || batch.materialFlags.clamp_t);
        mappings.push(this.textureCache.getTextureMapping(batch.material.texture_1, blp.inner, undefined, undefined, {
          wrap: wrap,
        }));
      }
    }
    return mappings;
  }

  public prepareToRenderWmo(renderInstManager: GfxRenderInstManager, defs: WmoDefinition[]) {
    for (let def of defs) {
      if (!def.visible) continue;
      assert(def.wmoId === this.wmo.fileId, `WmoRenderer handed a WmoDefinition that doesn't belong to it (${def.wmoId} != ${this.wmo.fileId}`);
      const template = renderInstManager.pushTemplateRenderInst();
      let offs = template.allocateUniformBuffer(WmoProgram.ub_ModelParams, 2 * 16);
      const mapped = template.mapUniformBufferF32(WmoProgram.ub_ModelParams);
      offs += fillMatrix4x4(mapped, offs, def.modelMatrix);
      const normalMat = mat4.mul(mat4.create(), def.modelMatrix, placementSpaceFromModelSpace);
      mat4.invert(normalMat, normalMat);
      mat4.transpose(normalMat, normalMat);
      offs += fillMatrix4x4(mapped, offs, normalMat);

      for (let i=0; i<this.vertexBuffers.length; i++) {
        const group = this.groups[i];
        if (!def.isWmoGroupVisible(group.fileId)) continue;
        const ambientColor = def.groupAmbientColors.get(group.fileId)!;
        const applyInteriorLight = group.flags.interior && !group.flags.exterior_lit;
        const applyExteriorLight = true;
        template.setVertexInput(this.inputLayouts[i], this.vertexBuffers[i], this.indexBuffers[i]);
        for (let j in this.batches[i]) {
          const batch = this.batches[i][j];
          if (!batch.visible) continue;
          const renderInst = renderInstManager.newRenderInst();
          let offset = renderInst.allocateUniformBuffer(WmoProgram.ub_BatchParams, 4 * 4);
          const uniformBuf = renderInst.mapUniformBufferF32(WmoProgram.ub_BatchParams);
          offset += fillVec4(uniformBuf, offset,
            batch.vertexShader,
            batch.pixelShader,
            0,
            0
          );
          offset += fillVec4(uniformBuf, offset,
            batch.material.blend_mode,
            applyInteriorLight ? 1 : 0,
            applyExteriorLight ? 1 : 0,
            0
          );
          offset += fillVec4v(uniformBuf, offset, ambientColor);
          offset += fillVec4v(uniformBuf, offset, [0, 0, 0, 0]);
          batch.setMegaStateFlags(renderInst);
          const textureMappings = this.groupBatchTextureMappings[i][j];
          renderInst.setSamplerBindingsFromTextureMappings(textureMappings);
          renderInst.drawIndexes(batch.indexCount, batch.indexStart);
          renderInstManager.submitRenderInst(renderInst);
        }
      }
      renderInstManager.popTemplateRenderInst();
    }
  }

  public destroy(device: GfxDevice) {
    for (let i=0; i<this.vertexBuffers.length; i++) {
      this.vertexBuffers[i].forEach(buf => device.destroyBuffer(buf.buffer));
      device.destroyBuffer(this.indexBuffers[i].buffer);
    }
  }
}

export class TerrainRenderer {
  private inputLayout: GfxInputLayout;
  public indexBuffer: GfxIndexBufferDescriptor;
  public vertexBuffer: GfxVertexBufferDescriptor;
  public adtChunks: ChunkData[] = [];
  public alphaTextureMappings: (TextureMapping | null)[] = [];
  public chunkTextureMappings: TextureMappingArray[] = [];

  constructor(device: GfxDevice, renderHelper: GfxRenderHelper, public adt: AdtData, private textureCache: TextureCache) {
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
    [this.vertexBuffer, this.indexBuffer, this.adtChunks] = this.adt.getBufsAndChunks(device);
    for (let i in this.adtChunks) {
      const chunk = this.adtChunks[i];
      this.chunkTextureMappings[i] = this.getChunkTextureMapping(chunk);

      const alphaTex = chunk.inner.alpha_texture;
      if (alphaTex) {
        this.chunkTextureMappings[i].push(textureCache.getAlphaTextureMapping(device, alphaTex));
      } else {
        this.chunkTextureMappings[i].push(textureCache.getAllBlackTextureMapping());
      }
    }
  }

  private getChunkTextureMapping(chunk: ChunkData): TextureMappingArray {
    let mapping: TextureMappingArray = [null, null, null, null];
    chunk.textures.forEach((blp, i) => {
      mapping[i] = this.textureCache.getTextureMapping(blp.fileId, blp.inner);
    })
    return mapping;
  }

  public prepareToRenderTerrain(renderInstManager: GfxRenderInstManager) {
    if (!this.adt.visible) return;
    const template = renderInstManager.pushTemplateRenderInst();
    template.setVertexInput(this.inputLayout, [this.vertexBuffer], this.indexBuffer);
    this.adtChunks.forEach((chunk, i) => {
      if (chunk.inner.index_count > 0) {
        const renderInst = renderInstManager.newRenderInst();
        const textureMapping = this.chunkTextureMappings[i];
        renderInst.setSamplerBindingsFromTextureMappings(textureMapping);
        renderInst.drawIndexes(chunk.inner.index_count, chunk.inner.index_offset);
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

export class SkyboxRenderer {
  private inputLayout: GfxInputLayout;
  private vertexBuffer: GfxVertexBufferDescriptor;
  private indexBuffer: GfxIndexBufferDescriptor;
  private skyboxProgram: GfxProgram;

  constructor(device: GfxDevice, renderHelper: GfxRenderHelper) {
    const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
      { location: SkyboxProgram.a_Position,   bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_RGB, },
      { location: SkyboxProgram.a_ColorIndex, bufferIndex: 0, bufferByteOffset: 3 * 4, format: GfxFormat.F32_R, },
    ];
    const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
      { byteStride: 16, frequency: GfxVertexBufferFrequency.PerVertex, },
    ];
    const indexBufferFormat: GfxFormat = GfxFormat.U16_R;
    this.inputLayout = renderHelper.renderCache.createInputLayout({ vertexAttributeDescriptors, vertexBufferDescriptors, indexBufferFormat });

    this.skyboxProgram = renderHelper.renderCache.createProgram(new SkyboxProgram());

    this.vertexBuffer = { byteOffset: 0, buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, skyboxVertices.buffer )}
    const convertedIndices = convertToTriangleIndexBuffer(GfxTopology.TriStrips, skyboxIndices);
    this.indexBuffer = { byteOffset: 0, buffer: makeStaticDataBuffer(device, GfxBufferUsage.Index, convertedIndices.buffer) };
  }

  public prepareToRenderSkybox(renderInstManager: GfxRenderInstManager) {
    const renderInst = renderInstManager.newRenderInst();
    renderInst.setGfxProgram(this.skyboxProgram);
    renderInst.setVertexInput(this.inputLayout, [this.vertexBuffer], this.indexBuffer);
    renderInst.setBindingLayouts(SkyboxProgram.bindingLayouts);
    renderInst.drawIndexes(skyboxIndices.length, 0);
    renderInstManager.submitRenderInst(renderInst);
  }

  public destroy(device: GfxDevice) {
    device.destroyBuffer(this.vertexBuffer.buffer);
    device.destroyBuffer(this.indexBuffer.buffer);
    device.destroyInputLayout(this.inputLayout);
  }
}
