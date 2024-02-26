import { vec3, mat4, vec4, quat } from "gl-matrix";
import { WowM2, WowSkin, WowBlp, WowSkinSubmesh, WowModelBatch, WowAdt, WowAdtChunkDescriptor, WowDoodad, WowWdt, WowWmo, WowWmoGroup, WowWmoMaterialInfo, WowWmoMaterialBatch, WowQuat, WowVec3, WowDoodadDef, WowWmoMaterial, WowAdtWmoDefinition, WowGlobalWmoDefinition, WowM2Material, WowM2MaterialFlags, WowM2BlendingMode, WowVec4, WowMapFileDataIDs, WowLightDatabase, WowWmoMaterialVertexShader, WowWmoMaterialPixelShader, WowWmoMaterialFlags, WowWmoGroupFlags, WowLightResult, WowWmoGroupInfo, WowAdtRenderResult, WowM2AnimationManager, WowArgb } from "../../rust/pkg";
import { DataFetcher } from "../DataFetcher.js";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers.js";
import { GfxDevice, GfxVertexBufferDescriptor, GfxIndexBufferDescriptor, GfxBufferUsage, GfxBlendMode, GfxCullMode, GfxBlendFactor, GfxChannelWriteMask, GfxCompareMode, GfxFormat, GfxVertexBufferFrequency, GfxInputLayout, GfxInputLayoutBufferDescriptor, GfxVertexAttributeDescriptor, GfxMegaStateDescriptor } from "../gfx/platform/GfxPlatform.js";
import { rust } from "../rustlib.js";
import { fetchFileByID, fetchDataByFileID, getFilePath } from "./util.js";
import { MathConstants, setMatrixTranslation } from "../MathHelpers.js";
import { adtSpaceFromModelSpace, adtSpaceFromPlacementSpace, placementSpaceFromModelSpace, noclipSpaceFromPlacementSpace, noclipSpaceFromModelSpace, noclipSpaceFromAdtSpace, modelSpaceFromAdtSpace, MapArray, WdtScene } from "./scenes.js";
import { AABB } from "../Geometry.js";
import { GfxRenderInst, GfxRendererLayer, makeSortKey, setSortKeyDepth } from "../gfx/render/GfxRenderInstManager.js";
import { BaseProgram, ModelProgram, WmoProgram } from "./program.js";
import { fillMatrix4x4, fillVec4, fillVec4v } from "../gfx/helpers/UniformBufferHelpers.js";
import { AttachmentStateSimple, setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers.js";
import { reverseDepthForCompareMode } from "../gfx/helpers/ReversedDepthHelpers.js";
import { computeViewSpaceDepthFromWorldSpaceAABB } from "../Camera";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { assert } from "../util.js";

// game world size in game units
const MAP_SIZE = 17066;

export class LightDatabase {
  private db: WowLightDatabase;

  constructor(public mapId: number) {
  }

  public async load(dataFetcher: DataFetcher) {
    let lightDbData = await fetchDataByFileID(1375579, dataFetcher);
    let lightDataDbData = await fetchDataByFileID(1375580, dataFetcher);
    let lightParamsDbData = await fetchDataByFileID(1334669, dataFetcher);
    this.db = rust.WowLightDatabase.new(lightDbData, lightDataDbData, lightParamsDbData);
  }

  public getGlobalLightingData(coords: vec3, time: number): WowLightResult {
    return this.db.get_lighting_data(this.mapId, coords[0], coords[1], coords[2], time);
  }
}

abstract class Loadable {
  public abstract load(dataFetcher: DataFetcher, cache: WowCache): Promise<void>
}

export class WowCache {
  private models: Map<number, ModelData> = new Map();
  private wmos: Map<number, WmoData> = new Map();
  private wmoGroups: Map<number, WmoGroupData> = new Map();
  private blps: Map<number, WowBlp> = new Map();

  constructor(public dataFetcher: DataFetcher) {
  }

  public clear() {
    this.models.clear();
    this.wmos.clear();
    this.wmoGroups.clear();
    this.blps.clear();
  }

  private async getOrLoad<T extends Loadable>(fileId: number, type: (new (fileId: number) => T), map: Map<number, T>): Promise<T> {
    let value = map.get(fileId);
    if (!value) {
      value = new type(fileId);
      await value.load(this.dataFetcher, this);
      map.set(fileId, value);
    }
    return value;
  }

  public async loadModel(fileId: number): Promise<ModelData> {
    return this.getOrLoad(fileId, ModelData, this.models);
  }

  public async loadWmo(fileId: number): Promise<WmoData> {
    return this.getOrLoad(fileId, WmoData, this.wmos);
  }

  public async loadWmoGroup(fileId: number): Promise<WmoGroupData> {
    return this.getOrLoad(fileId, WmoGroupData, this.wmoGroups);
  }

  public async loadBlp(fileId: number): Promise<WowBlp> {
    let blp = this.blps.get(fileId);
    if (!blp) {
      blp = await fetchFileByID(fileId, this.dataFetcher, rust.WowBlp.new);
      this.blps.set(fileId, blp);
    }
    return blp;
  }
}

export class ModelData {
  public skins: WowSkin[] = [];
  public blps: BlpData[] = [];
  public vertexBuffer: Uint8Array;
  public vertexColors: Float32Array;
  public textureWeights: Float32Array;
  public textureRotations: Float32Array;
  public textureScalings: Float32Array;
  public textureTranslations: Float32Array;
  public boneRotations: Float32Array;
  public boneScalings: Float32Array;
  public boneTranslations: Float32Array;
  public textureTransforms: mat4[] = [];
  public boneTransforms: mat4[] = [];
  public bonePivots: mat4[] = [];
  public boneAntipivots: mat4[] = [];
  public boneParents: Int16Array;
  public materials: [WowM2BlendingMode, WowM2MaterialFlags][] = [];
  public animationManager: WowM2AnimationManager;
  public textureLookupTable: Uint16Array;
  public boneLookupTable: Uint16Array;
  public textureTransparencyLookupTable: Uint16Array;
  public textureTransformLookupTable: Uint16Array;
  public modelAABB: AABB;

  constructor(public fileId: number) {
  }

  public async load(dataFetcher: DataFetcher, cache: WowCache): Promise<undefined> {
    const m2 = await fetchFileByID(this.fileId, dataFetcher, rust.WowM2.new);
    if (m2.skeleton_file_id !== undefined) {
      console.log(m2);
    }
    for (let txid of m2.texture_ids) {
      if (txid === 0) continue;
      try {
        this.blps.push(new BlpData(txid, await cache.loadBlp(txid)));
      } catch (e) {
        console.error(`failed to load BLP: ${e}`)
      }
    }
    this.vertexBuffer = m2.take_vertex_data();

    const aabb = m2.get_bounding_box();
    const min = aabb.min;
    const max = aabb.max;
    this.modelAABB = new AABB(
      min.x,
      min.y,
      min.z,
      max.x,
      max.y,
      max.z,
    );
    aabb.free();
    min.free();
    max.free();

    this.textureLookupTable = m2.take_texture_lookup();
    this.boneLookupTable = m2.take_bone_lookup();
    this.textureTransformLookupTable = m2.take_texture_transform_lookup();
    this.textureTransparencyLookupTable = m2.take_texture_transparency_lookup();

    const m2Materials = m2.materials;
    this.materials = m2Materials.map(mat => {
      return [mat.blending_mode, rust.WowM2MaterialFlags.new(mat.flags)];
    });
    m2Materials.forEach(mat => mat.free());

    for (let skid of m2.skin_ids) {
      this.skins.push(await fetchFileByID(skid, dataFetcher, rust.WowSkin.new));
    }
    this.animationManager = m2.take_animation_manager();
    this.textureWeights = new Float32Array(this.animationManager.get_num_texture_weights());
    const numTransformations = this.animationManager.get_num_transformations();
    this.textureTranslations = new Float32Array(numTransformations * 3);
    this.textureRotations = new Float32Array(numTransformations * 4);
    this.textureScalings = new Float32Array(numTransformations * 3);
    const numBones = this.animationManager.get_num_bones();
    this.boneTranslations = new Float32Array(numBones * 3);
    this.boneRotations = new Float32Array(numBones * 4);
    this.boneScalings = new Float32Array(numBones * 3);
    this.vertexColors = new Float32Array(this.animationManager.get_num_colors() * 3);
    for (let i=0; i<numTransformations; i++) {
      this.textureTransforms.push(mat4.create());
    }
    for (let i=0; i<numBones; i++) {
      this.boneTransforms.push(mat4.create());
    }
    this.boneParents = this.animationManager.get_bone_parents();
    for (let pivot of this.animationManager.get_bone_pivots()) {
      this.bonePivots.push(mat4.fromTranslation(mat4.create(), [pivot.x, pivot.y, pivot.z]));
      this.boneAntipivots.push(mat4.fromTranslation(mat4.create(), [-pivot.x, -pivot.y, -pivot.z]));
      pivot.free();
    }
    m2.free();
  }

  public updateAnimation(deltaTime: number) {
    this.animationManager.update_animations(
      deltaTime,
      this.textureWeights,
      this.textureTranslations,
      this.textureRotations,
      this.textureScalings,
      this.boneTranslations,
      this.boneRotations,
      this.boneScalings,
      this.vertexColors
    );

    const pivot: vec3 = [0.5, 0.5, 0];
    const antiPivot: vec3 = [-0.5, -0.5, 0];
    const numTransforms = this.animationManager.get_num_transformations();
    for (let i = 0; i < numTransforms; i++) {
      mat4.identity(this.textureTransforms[i]);
      mat4.translate(this.textureTransforms[i], this.textureTransforms[i], pivot);
      const rotation: vec4 = this.textureRotations.slice(i * 4, (i + 1) * 4);
      mat4.fromQuat(this.textureTransforms[i], rotation);
      const scaling: vec3 = this.textureScalings.slice(i * 3, (i + 1) * 3);
      mat4.scale(this.textureTransforms[i], this.textureTransforms[i], scaling);
      mat4.translate(this.textureTransforms[i], this.textureTransforms[i], antiPivot);

      const translation: vec3 = this.textureTranslations.slice(i * 3, (i + 1) * 3);
      mat4.translate(this.textureTransforms[i], this.textureTransforms[i], translation);
    }

    const numBones = this.animationManager.get_num_bones();
    for (let i = 0; i < numBones; i++) {
      const parentId = this.boneParents[i];
      assert(parentId < i, "bone parent > bone");
      mat4.fromRotationTranslationScale(this.boneTransforms[i],
        this.boneRotations.slice(i * 4, (i + 1) * 4),
        this.boneTranslations.slice(i * 3, (i + 1) * 3),
        this.boneScalings.slice(i * 3, (i + 1) * 3),
      );
      mat4.mul(this.boneTransforms[i], this.bonePivots[i], this.boneTransforms[i]);
      mat4.mul(this.boneTransforms[i], this.boneTransforms[i], this.boneAntipivots[i]);
      if (parentId >= 0) {
        mat4.mul(this.boneTransforms[i], this.boneTransforms[parentId], this.boneTransforms[i]);
      }
    }
  }

  public getVertexColor(index: number): vec4 {
    if (index * 4 < this.vertexColors.length) {
      return this.vertexColors.slice(index * 4, (index + 1) * 4);
    }
    return [1, 1, 1, 1];
  }
}

export class BlpData {
  constructor(public fileId: number, public inner: WowBlp) {
  }
}

export class WmoBatchData {
  public indexStart: number;
  public indexCount: number;
  public materialId: number;
  public material: WowWmoMaterial;
  public materialFlags: WowWmoMaterialFlags;
  public vertexShader: WowWmoMaterialVertexShader;
  public pixelShader: WowWmoMaterialPixelShader;
  public textures: (BlpData | null)[] = [];
  public megaStateFlags: Partial<GfxMegaStateDescriptor>;
  public visible = true;

  constructor(batch: WowWmoMaterialBatch, wmo: WmoData) {
    this.indexStart = batch.start_index;
    this.indexCount = batch.index_count;
    if (batch.use_material_id_large > 0) {
      this.materialId = batch.material_id_large;
    } else {
      this.materialId = batch.material_id;
    }
    this.material = wmo.materials[this.materialId];
    for (let blpId of [this.material.texture_1, this.material.texture_2, this.material.texture_3]) {
      if (blpId === 0) {
        this.textures.push(null);
      } else {
        this.textures.push(wmo.blps.get(blpId)!);
      }
    }
    this.materialFlags = rust.WowWmoMaterialFlags.new(this.material.flags);
    this.vertexShader = this.material.get_vertex_shader();
    this.pixelShader = this.material.get_pixel_shader();
    this.megaStateFlags = {
      cullMode: this.materialFlags.unculled ? GfxCullMode.None : GfxCullMode.Back,
      depthWrite: this.material.blend_mode <= 1,
    };
  }

  public setMegaStateFlags(renderInst: GfxRenderInst) {
    // TODO setSortKeyDepth based on distance to transparent object
    switch (this.material.blend_mode) {
      case rust.WowM2BlendingMode.Alpha: {
        setAttachmentStateSimple(this.megaStateFlags, {
          blendMode: GfxBlendMode.Add,
          blendSrcFactor: GfxBlendFactor.SrcAlpha,
          blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
        });
        renderInst.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT)
        break;
      }
      case rust.WowM2BlendingMode.NoAlphaAdd: {
        setAttachmentStateSimple(this.megaStateFlags, {
          blendMode: GfxBlendMode.Add,
          blendSrcFactor: GfxBlendFactor.One,
          blendDstFactor: GfxBlendFactor.One,
        });
        renderInst.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT)
        break;
      }
      case rust.WowM2BlendingMode.Add: {
        setAttachmentStateSimple(this.megaStateFlags, {
          blendMode: GfxBlendMode.Add,
          blendSrcFactor: GfxBlendFactor.SrcAlpha,
          blendDstFactor: GfxBlendFactor.One,
        });
        renderInst.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT)
        break;
      }
      case rust.WowM2BlendingMode.Mod: {
        setAttachmentStateSimple(this.megaStateFlags, {
          blendMode: GfxBlendMode.Add,
          blendSrcFactor: GfxBlendFactor.Dst,
          blendDstFactor: GfxBlendFactor.Zero,
        });
        renderInst.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT)
        break;
      }
      case rust.WowM2BlendingMode.Mod2x: {
        setAttachmentStateSimple(this.megaStateFlags, {
          blendMode: GfxBlendMode.Add,
          blendSrcFactor: GfxBlendFactor.Dst,
          blendDstFactor: GfxBlendFactor.Src,
        });
        renderInst.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT)
        break;
      }
      case rust.WowM2BlendingMode.BlendAdd: {

        setAttachmentStateSimple(this.megaStateFlags, {
          blendMode: GfxBlendMode.Add,
          blendSrcFactor: GfxBlendFactor.One,
          blendDstFactor: GfxBlendFactor.SrcAlpha,
        });
        renderInst.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT)
        break;
      }
      case rust.WowM2BlendingMode.Opaque:
      case rust.WowM2BlendingMode.AlphaKey:
        break;
    }
    renderInst.setMegaStateFlags(this.megaStateFlags);
  }
}

export class WmoGroupData {
  public innerBatches: WowWmoMaterialBatch[] = [];
  public flags: WowWmoGroupFlags;
  public doodadRefs: Uint16Array;
  public replacementForHeaderColor: WowArgb | undefined;
  public numUVBufs: number;
  public numVertices: number;
  public numColorBufs: number;
  public visible = true;
  public vertices: Uint8Array;
  public normals: Uint8Array;
  public indices: Uint8Array;
  public uvs: Uint8Array;
  public colors: Uint8Array;

  constructor(public fileId: number) {
  }

  public getBatches(wmo: WmoData): WmoBatchData[] {
    const batches: WmoBatchData[] = [];
    for (let batch of this.innerBatches) {
      batches.push(new WmoBatchData(batch, wmo))
    }
    return batches;
  }

  public getAmbientColor(wmoData: WmoData, doodadSetId: number): vec4 {
    if (!this.flags.exterior && !this.flags.exterior_lit) {
      if (this.replacementForHeaderColor) {
        return [
          this.replacementForHeaderColor.r / 255.0,
          this.replacementForHeaderColor.g / 255.0,
          this.replacementForHeaderColor.b / 255.0,
          1.0,
        ];
      } else {
        const color = wmoData.wmo.get_ambient_color(doodadSetId);
        return [
          color.r / 255.0,
          color.g / 255.0,
          color.b / 255.0,
          1.0,
        ];
      }
    }
    return [0, 0, 0, 0];
  }

  public getVertexBuffers(device: GfxDevice): GfxVertexBufferDescriptor[] {
    return [
      { byteOffset: 0, buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, this.vertices.buffer) },
      { byteOffset: 0, buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, this.normals.buffer) },
      { byteOffset: 0, buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, this.uvs.buffer) },
      { byteOffset: 0, buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, this.colors.buffer) },
    ];
  }

  public getInputLayout(renderCache: GfxRenderCache): GfxInputLayout {
    const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
      { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex, },
      { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex, },
      { byteStride: 8, frequency: GfxVertexBufferFrequency.PerVertex, },
      { byteStride: 4, frequency: GfxVertexBufferFrequency.PerVertex, },
    ];
    const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
      { location: WmoProgram.a_Position, bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_RGB, },
      { location: WmoProgram.a_Normal,   bufferIndex: 1, bufferByteOffset: 0, format: GfxFormat.F32_RGB, },
    ];
    for (let i=0; i<this.numUVBufs; i++) {
      vertexAttributeDescriptors.push({
        location: WmoProgram.a_TexCoord0 + i,
        bufferIndex: 2,
        bufferByteOffset: 8 * i * this.numVertices,
        format: GfxFormat.F32_RG,
      });
    }
    for (let i=0; i<this.numColorBufs; i++) {
      vertexAttributeDescriptors.push({
        location: WmoProgram.a_Color0 + i,
        bufferIndex: 3,
        bufferByteOffset: 4 * i * this.numVertices,
        format: GfxFormat.U8_RGBA,
      });
    }
    const indexBufferFormat: GfxFormat = GfxFormat.U16_R;
    return renderCache.createInputLayout({
      vertexAttributeDescriptors,
      vertexBufferDescriptors,
      indexBufferFormat,
    });
  }

  public getIndexBuffer(device: GfxDevice): GfxIndexBufferDescriptor {
    return { byteOffset: 0, buffer: makeStaticDataBuffer(device, GfxBufferUsage.Index, this.indices.buffer) }
  }

  public async load(dataFetcher: DataFetcher, cache: WowCache): Promise<undefined> {
    const group = await fetchFileByID(this.fileId, dataFetcher, rust.WowWmoGroup.new);
    this.replacementForHeaderColor = group.replacement_for_header_color;
    this.numVertices = group.num_vertices;
    this.numUVBufs = group.num_uv_bufs;
    this.numColorBufs = group.num_color_bufs;
    this.innerBatches = group.batches;
    this.vertices = group.take_vertices();
    this.normals = group.take_normals();
    this.colors = group.take_colors();
    this.uvs = group.take_uvs();
    this.indices = group.take_indices();
    this.flags = rust.WowWmoGroupFlags.new(group.header.flags);
    this.doodadRefs = group.take_doodad_refs();
    group.free();
  }
}

export class WmoData {
  public wmo: WowWmo;
  public groups: WmoGroupData[] = [];
  public groupInfos: WowWmoGroupInfo[] = [];
  public groupAABBs: AABB[] = [];
  public blps: Map<number, BlpData> = new Map();
  public materials: WowWmoMaterial[] = [];
  public models: Map<number, ModelData> = new Map();
  public modelIds: Uint32Array;

  constructor(public fileId: number) {
  }

  public async load(dataFetcher: DataFetcher, cache: WowCache): Promise<void> {
    this.wmo = await fetchFileByID(this.fileId, dataFetcher, rust.WowWmo.new);

    for (let material of this.wmo.textures) {
      this.materials.push(material);
      for (let texId of [material.texture_1, material.texture_2, material.texture_3]) {
        if (texId !== 0 && !this.blps.has(texId)) {
          try {
            this.blps.set(texId, new BlpData(texId, await cache.loadBlp(texId)));
          } catch (e) {
            console.error(`failed to fetch BLP: ${e}`);
          }
        }
      }
    }

    this.modelIds = this.wmo.doodad_file_ids;
    for (let modelId of this.modelIds) {
      if (modelId !== 0)
        this.models.set(modelId, await cache.loadModel(modelId))
    }

    this.groupInfos = this.wmo.group_infos;
    for (let i=0; i<this.wmo.group_file_ids.length; i++) {
      const gfid = this.wmo.group_file_ids[i];
      this.groups.push(await cache.loadWmoGroup(gfid));
      const groupInfo = this.groupInfos[i];
      const wowAABB = groupInfo.bounding_box;
      this.groupAABBs.push(new AABB(
        wowAABB.min.x,
        wowAABB.min.y,
        wowAABB.min.z,
        wowAABB.max.x,
        wowAABB.max.y,
        wowAABB.max.z,
      ));
    }
  }
}

export class SkinData {
  public submeshes: WowSkinSubmesh[];
  public batches: WowModelBatch[];
  public indexBuffer: Uint16Array;
  public renderPasses: ModelRenderPass[];

  constructor(public skin: WowSkin, model: ModelData) {
    this.submeshes = skin.submeshes;
    this.batches = skin.batches;
    this.renderPasses = this.batches.map(batch => new ModelRenderPass(batch, this.skin, model));
    this.indexBuffer = skin.take_indices();
  }
}

export class ModelRenderPass {
  public vertexShaderId: number;
  public fragmentShaderId: number;
  public blendMode: WowM2BlendingMode;
  public materialFlags: WowM2MaterialFlags;
  public submesh: WowSkinSubmesh;
  public tex0: BlpData;
  public tex1: BlpData | null;
  public tex2: BlpData | null;
  public tex3: BlpData | null;

  constructor(public batch: WowModelBatch, public skin: WowSkin, public model: ModelData) {
    this.fragmentShaderId = batch.get_pixel_shader();
    this.vertexShaderId = batch.get_vertex_shader();
    this.submesh = skin.submeshes[batch.skin_submesh_index];
    [this.blendMode, this.materialFlags] = model.materials[this.batch.material_index];
    this.tex0 = this.getBlp(0)!;
    this.tex1 = this.getBlp(1);
    this.tex2 = this.getBlp(2);
    this.tex3 = this.getBlp(3);
  }

  public setMegaStateFlags(renderInst: GfxRenderInst) {
    let settings = {
      cullMode: this.materialFlags.two_sided ? GfxCullMode.None : GfxCullMode.Back,
      depthWrite: this.materialFlags.depth_write,
      depthCompare: this.materialFlags.depth_tested ? reverseDepthForCompareMode(GfxCompareMode.LessEqual) : GfxCompareMode.Always,
    };
    // TODO setSortKeyDepth based on distance to transparent object
    switch (this.blendMode) {
      case rust.WowM2BlendingMode.Alpha: {
        setAttachmentStateSimple(settings, {
          blendMode: GfxBlendMode.Add,
          blendSrcFactor: GfxBlendFactor.SrcAlpha,
          blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
        });
        renderInst.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT)
        break;
      }
      case rust.WowM2BlendingMode.NoAlphaAdd: {
        setAttachmentStateSimple(settings, {
          blendMode: GfxBlendMode.Add,
          blendSrcFactor: GfxBlendFactor.One,
          blendDstFactor: GfxBlendFactor.One,
        });
        renderInst.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT)
        break;
      }
      case rust.WowM2BlendingMode.Add: {
        setAttachmentStateSimple(settings, {
          blendMode: GfxBlendMode.Add,
          blendSrcFactor: GfxBlendFactor.SrcAlpha,
          blendDstFactor: GfxBlendFactor.One,
        });
        renderInst.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT)
        break;
      }
      case rust.WowM2BlendingMode.Mod: {
        setAttachmentStateSimple(settings, {
          blendMode: GfxBlendMode.Add,
          blendSrcFactor: GfxBlendFactor.Dst,
          blendDstFactor: GfxBlendFactor.Zero,
        });
        renderInst.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT)
        break;
      }
      case rust.WowM2BlendingMode.Mod2x: {
        setAttachmentStateSimple(settings, {
          blendMode: GfxBlendMode.Add,
          blendSrcFactor: GfxBlendFactor.Dst,
          blendDstFactor: GfxBlendFactor.Src,
        });
        renderInst.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT)
        break;
      }
      case rust.WowM2BlendingMode.BlendAdd: {

        setAttachmentStateSimple(settings, {
          blendMode: GfxBlendMode.Add,
          blendSrcFactor: GfxBlendFactor.One,
          blendDstFactor: GfxBlendFactor.SrcAlpha,
        });
        renderInst.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT)
        break;
      }
      case rust.WowM2BlendingMode.Opaque:
      case rust.WowM2BlendingMode.AlphaKey:
        break;
    }
    renderInst.setMegaStateFlags(settings);
  }

  private getBlp(n: number): BlpData | null {
    if (n < this.batch.texture_count) {
      const i = this.model.textureLookupTable[this.batch.texture_combo_index + n]!;
      if (this.model.blps[i]) {
        return this.model.blps[i];
      }
    }
    return null;
  }

  private getCurrentVertexColor(): vec4 {
    return this.model.getVertexColor(this.batch.color_index);
  }

  private getTextureTransform(texIndex: number): mat4 {
    const lookupIndex = this.batch.texture_transform_combo_index + texIndex;
    const transformIndex = this.model.textureTransformLookupTable[lookupIndex];
    if (transformIndex !== undefined) {
      if (transformIndex < this.model.textureTransforms.length) {
        return this.model.textureTransforms[transformIndex];
      }
    }
    return mat4.identity(mat4.create())
  }

  private getTextureWeight(texIndex: number): number {
    const lookupIndex = this.batch.texture_weight_combo_index + texIndex;
    const transparencyIndex = this.model.textureTransparencyLookupTable[lookupIndex];
    if (transparencyIndex !== undefined) {
      if (transparencyIndex < this.model.textureWeights.length) {
        return this.model.textureWeights[transparencyIndex];
      }
    }
    return 1.0;
  }

  private getAlphaTest(): number {
    if (this.blendMode == rust.WowM2BlendingMode.AlphaKey) {
      const color = this.getCurrentVertexColor();
      let finalTransparency = color[3];
      if (!(this.batch.flags & 0x40))
        finalTransparency *= this.getTextureWeight(0);
      // TODO skyboxes need another alpha value mixed in
      return (128/255) * finalTransparency;
    } else {
      return 1/255;
    }
  }

  public setModelParams(renderInst: GfxRenderInst) {
    const numVec4s = 4;
    const numMat4s = 3;
    let offset = renderInst.allocateUniformBuffer(ModelProgram.ub_MaterialParams, numVec4s * 4 + numMat4s * 16);
    const uniformBuf = renderInst.mapUniformBufferF32(ModelProgram.ub_MaterialParams);
    offset += fillVec4(uniformBuf, offset,
      this.fragmentShaderId,
      this.vertexShaderId,
      0,
      0
    );
    offset += fillVec4(uniformBuf, offset,
      this.blendMode,
      this.materialFlags.unfogged ? 1 : 0,
      this.materialFlags.unlit ? 1 : 0,
      this.getAlphaTest()
    );
    offset += fillVec4v(uniformBuf, offset, this.getCurrentVertexColor());
    offset += fillMatrix4x4(uniformBuf, offset, this.getTextureTransform(0));
    offset += fillMatrix4x4(uniformBuf, offset, this.getTextureTransform(1));
    const textureWeight: vec4 = [
      this.getTextureWeight(0),
      this.getTextureWeight(1),
      this.getTextureWeight(2),
      this.getTextureWeight(3),
    ];
    offset += fillVec4v(uniformBuf, offset, textureWeight);
  }
}

export class WmoDefinition {
  public modelMatrix: mat4 = mat4.create();
  public normalMatrix: mat4 = mat4.create();
  public worldSpaceAABB: AABB = new AABB();
  public groupDefAABBs: Map<number, AABB> = new Map();
  public visible = true;
  public doodads: DoodadData[] = [];
  public groupIdToVisibility: Map<number, boolean> = new Map();
  public groupIdToDoodadIndices: MapArray<number, number> = new MapArray();
  public groupAmbientColors: Map<number, vec4> = new Map();

  public setVisible(visible: boolean) {
    this.visible = visible;
    for (let doodad of this.doodads) {
      doodad.setVisible(visible);
    }
    for (let groupId of this.groupIdToVisibility.keys()) {
      this.groupIdToVisibility.set(groupId, visible);
    }
  }

  static fromAdtDefinition(def: WowAdtWmoDefinition, wmo: WmoData) {
    const scale = def.scale / 1024;
    const defPos = def.position;
    const position: vec3 = [
      defPos.x - MAP_SIZE,
      defPos.y,
      defPos.z - MAP_SIZE,
    ];
    defPos.free();
    const defRot = def.rotation;
    const rotation: vec3 = [
      defRot.x,
      defRot.y,
      defRot.z,
    ];
    defRot.free();
    const extents = def.extents;
    const min = extents.min;
    const max = extents.max;
    const aabb = new AABB(
      min.x - MAP_SIZE,
      min.y,
      min.z - MAP_SIZE,
      max.x - MAP_SIZE,
      max.y,
      max.z - MAP_SIZE,
    )
    extents.free();
    min.free();
    max.free();
    const fileId = def.name_id;
    const uniqueId = def.unique_id;
    const doodadSet = def.doodad_set;
    def.free();
    return new WmoDefinition(fileId, wmo, uniqueId, doodadSet, scale, position, rotation, aabb);
  }

  static fromGlobalDefinition(def: WowGlobalWmoDefinition, wmo: WmoData) {
    const scale = 1.0;
    const defPos = def.position;
    const position: vec3 = [
      defPos.x - MAP_SIZE,
      defPos.y,
      defPos.z - MAP_SIZE,
    ];
    defPos.free();
    const defRot = def.rotation;
    const rotation: vec3 = [
      defRot.x,
      defRot.y,
      defRot.z,
    ];
    defRot.free();
    const extents = def.extents;
    const min = extents.min;
    const max = extents.max;
    const aabb = new AABB(
      min.x - MAP_SIZE,
      min.y,
      min.z - MAP_SIZE,
      max.x - MAP_SIZE,
      max.y,
      max.z - MAP_SIZE,
    )
    extents.free();
    min.free();
    max.free();
    const fileId = def.name_id;
    const uniqueId = def.unique_id;
    const doodadSet = def.doodad_set;
    def.free();
    return new WmoDefinition(fileId, wmo, uniqueId, doodadSet, scale, position, rotation, aabb);
  }

  // `extents` should be in placement space
  constructor(public wmoId: number, wmo: WmoData, public uniqueId: number, public doodadSet: number, scale: number, position: vec3, rotation: vec3, extents: AABB) {
    setMatrixTranslation(this.modelMatrix, position);
    mat4.scale(this.modelMatrix, this.modelMatrix, [scale, scale, scale]);
    mat4.rotateZ(this.modelMatrix, this.modelMatrix, MathConstants.DEG_TO_RAD * rotation[2]);
    mat4.rotateY(this.modelMatrix, this.modelMatrix, MathConstants.DEG_TO_RAD * rotation[1]);
    mat4.rotateX(this.modelMatrix, this.modelMatrix, MathConstants.DEG_TO_RAD * rotation[0]);
    mat4.mul(this.modelMatrix, this.modelMatrix, placementSpaceFromModelSpace);
    mat4.mul(this.modelMatrix, adtSpaceFromPlacementSpace, this.modelMatrix);

    mat4.mul(this.normalMatrix, this.modelMatrix, placementSpaceFromModelSpace);
    mat4.invert(this.normalMatrix, this.normalMatrix);
    mat4.transpose(this.normalMatrix, this.normalMatrix);

    for (let i=0; i<wmo.groups.length; i++) {
      const group = wmo.groups[i];
      const groupAABB = new AABB();
      groupAABB.transform(wmo.groupAABBs[i], this.modelMatrix);
      this.groupDefAABBs.set(group.fileId, groupAABB);
      this.groupAmbientColors.set(group.fileId, group.getAmbientColor(wmo, doodadSet));
    }

    for (let wmoDoodad of wmo.wmo.get_doodad_set(this.doodadSet)!) {
      this.doodads.push(DoodadData.fromWmoDoodad(wmoDoodad, wmo.modelIds, this.modelMatrix));
    }

    // keep track of which doodads belong in which group for culling purposes
    const doodadRefs = wmo.wmo.get_doodad_set_refs(this.doodadSet);
    for (let group of wmo.groups) {
      for (let ref of group.doodadRefs) {
        const index = doodadRefs.indexOf(ref);
        if (index !== -1) {
          this.groupIdToDoodadIndices.append(group.fileId, index);
        }
      }

      for (let index of this.groupIdToDoodadIndices.get(group.fileId)) {
        const doodad = this.doodads[index];
        doodad.ambientColor = this.groupAmbientColors.get(group.fileId)!;
        doodad.applyInteriorLighting = group.flags.interior && !group.flags.exterior_lit;
        doodad.applyExteriorLighting = true;
      }
    }

    this.worldSpaceAABB.transform(extents, adtSpaceFromPlacementSpace);
    this.visible = true;
  }

  public isWmoGroupVisible(groupFileId: number): boolean {
    const visible = this.groupIdToVisibility.get(groupFileId);
    // default to true
    if (visible === undefined) {
      return true;
    }
    return visible;
  }

  public setGroupVisible(groupId: number, visible: boolean) {
    this.groupIdToVisibility.set(groupId, visible);
    if (this.groupIdToDoodadIndices.has(groupId)) {
      for (let index of this.groupIdToDoodadIndices.get(groupId)) {
        this.doodads[index].setVisible(visible);
      }
    }
  }
}

export class AdtLodData {
  public modelIds: number[] = [];
  public wmoDefs: WmoDefinition[] = [];
  public doodads: DoodadData[] = [];

  public setVisible(visible: boolean) {
    for (let wmoDef of this.wmoDefs) {
      wmoDef.setVisible(visible);
    }
    for (let doodad of this.doodads) {
      doodad.setVisible(visible);
    }
  }
}

export class AdtData {
  public blps: Map<number, BlpData> = new Map();
  public models: Map<number, ModelData> = new Map();
  public wmos: Map<number, WmoData> = new Map();
  public worldSpaceAABB: AABB;
  public hasBigAlpha: boolean;
  public hasHeightTexturing: boolean;
  public lodLevel = 0;
  public lodData: AdtLodData[] = [];
  public visible = true;
  public chunkData: ChunkData[] = [];
  private vertexBuffer: Float32Array;
  private indexBuffer: Uint16Array;
  private inner: WowAdt | null = null;

  constructor(public fileId: number, adt: WowAdt) {
    this.inner = adt;
  }

  public setVisible(visible: boolean, lodLevel?: number) {
    this.visible = visible;
    if (lodLevel === undefined) {
      this.lodData[0].setVisible(visible);
      this.lodData[1].setVisible(visible);
    } else {
      this.lodData[lodLevel].setVisible(visible);
    }
  }

  public setLodLevel(lodLevel: number) {
    assert(lodLevel === 0 || lodLevel === 1, "lodLevel must be 0 or 1");
    this.lodLevel = lodLevel;
    if (this.lodLevel === 0) {
      this.lodData[0].setVisible(true);
      this.lodData[1].setVisible(false);
    } else {
      this.lodData[0].setVisible(false);
      this.lodData[1].setVisible(true);
    }
  }
  
  public async load(dataFetcher: DataFetcher, cache: WowCache) {
    for (let blpId of this.inner!.get_texture_file_ids()) {
      try {
        this.blps.set(blpId, new BlpData(blpId, await cache.loadBlp(blpId)));
      } catch (e) {
        console.error(`failed to load BLP ${e}`);
      }
    }

    for (let lodLevel of [0, 1]) {
      const lodData = new AdtLodData();

      for (let adtDoodad of this.inner!.get_doodads(lodLevel)) {
        const doodad = DoodadData.fromAdtDoodad(adtDoodad);
        doodad.applyExteriorLighting = true;
        lodData.doodads.push(doodad);
      }

      for (let modelId of this.inner!.get_model_file_ids(lodLevel)) {
        this.models.set(modelId, await cache.loadModel(modelId));
        lodData.modelIds.push(modelId);
      }

      for (let wmoDef of this.inner!.get_wmo_defs(lodLevel)) {
        const wmo = await cache.loadWmo(wmoDef.name_id);
        this.wmos.set(wmoDef.name_id, wmo);
        lodData.wmoDefs.push(WmoDefinition.fromAdtDefinition(wmoDef, wmo));
      }
      if (lodLevel > 0 && lodData.modelIds.length > 0) {
        console.log(lodData);
      }

      this.lodData.push(lodData);
    }

    const renderResult = this.inner!.get_render_result(this.hasBigAlpha, this.hasHeightTexturing);
    const extents = renderResult.extents;
    const min = extents.min;
    const max = extents.max;
    this.worldSpaceAABB = new AABB(
      min.x,
      min.y,
      min.z,
      max.x,
      max.y,
      max.z,
    );
    extents.free();
    min.free();
    max.free();
    this.worldSpaceAABB.transform(this.worldSpaceAABB, noclipSpaceFromAdtSpace);
    this.worldSpaceAABB.transform(this.worldSpaceAABB, adtSpaceFromPlacementSpace);
    this.vertexBuffer = renderResult.take_vertex_buffer();
    this.indexBuffer = renderResult.take_index_buffer();
    let i = 0;
    const worldSpaceChunkWidth = 100 / 3;
    for (let chunk of renderResult.chunks) {
      const x = 15 - i % 16;
      const y = 15 - Math.floor(i / 16);
      const chunkWorldSpaceAABB = new AABB();
      chunkWorldSpaceAABB.minX = this.worldSpaceAABB.minX + y * worldSpaceChunkWidth;
      chunkWorldSpaceAABB.minY = this.worldSpaceAABB.minY + x * worldSpaceChunkWidth;
      chunkWorldSpaceAABB.minZ = this.worldSpaceAABB.minZ;

      chunkWorldSpaceAABB.maxX = this.worldSpaceAABB.minX + (y + 1) * worldSpaceChunkWidth;
      chunkWorldSpaceAABB.maxY = this.worldSpaceAABB.minY + (x + 1) * worldSpaceChunkWidth;
      chunkWorldSpaceAABB.maxZ = this.worldSpaceAABB.maxZ;
      const textures = [];
      for (let blpId of chunk.texture_layers) {
        textures.push(this.blps.get(blpId)!);
      }
      this.chunkData.push(new ChunkData(chunk, textures, chunkWorldSpaceAABB));
      i += 1;
    }
    renderResult.free();
    this.inner!.free();
    this.inner = null;
  }

  public lodDoodads(): DoodadData[] {
    return this.lodData[this.lodLevel].doodads;
  }

  public lodWmoDefs(): WmoDefinition[] {
    return this.lodData[this.lodLevel].wmoDefs;
  }

  public getBufsAndChunks(device: GfxDevice): [GfxVertexBufferDescriptor, GfxIndexBufferDescriptor] {
    const vertexBuffer = {
      buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, this.vertexBuffer.buffer),
      byteOffset: 0,
    };
    const indexBuffer = {
      buffer: makeStaticDataBuffer(device, GfxBufferUsage.Index, this.indexBuffer.buffer),
      byteOffset: 0,
    };
    return [vertexBuffer, indexBuffer];
  }
}

export class ChunkData {
  public alphaTexture: Uint8Array | undefined;
  public indexCount: number;
  public indexOffset: number;
  public visible = true;

  constructor(chunk: WowAdtChunkDescriptor, public textures: BlpData[], public worldSpaceAABB: AABB) {
    this.alphaTexture = chunk.alpha_texture;
    this.indexCount = chunk.index_count;
    this.indexOffset = chunk.index_offset;
    chunk.free();
  }

  public setVisible(visible: boolean) {
    this.visible = visible;
  }
}

export class DoodadData {
  public visible = true;
  public worldAABB = new AABB();
  public normalMatrix = mat4.create();
  public ambientColor: vec4 = [0, 0, 0, 0];
  public applyInteriorLighting = false;
  public applyExteriorLighting = false;
  public interiorExteriorBlend = 0;

  constructor(public modelId: number, public modelMatrix: mat4, public color: number[] | null) {
    mat4.mul(this.normalMatrix, this.modelMatrix, placementSpaceFromModelSpace);
    mat4.mul(this.normalMatrix, adtSpaceFromPlacementSpace, this.modelMatrix);
    mat4.invert(this.normalMatrix, this.normalMatrix);
    mat4.transpose(this.normalMatrix, this.normalMatrix);
  }

  public setVisible(visible: boolean) {
    this.visible = visible;
  }

  static fromAdtDoodad(doodad: WowDoodad): DoodadData {
    const doodadPos = doodad.position;
    let position: vec3 = [doodadPos.x - MAP_SIZE, doodadPos.y, doodadPos.z - MAP_SIZE];
    doodadPos.free();
    const doodadRot = doodad.rotation;
    let rotation: vec3 = [doodadRot.x, doodadRot.y, doodadRot.z];
    doodadRot.free();
    let scale = doodad.scale / 1024;
    const doodadMat = mat4.create();
    setMatrixTranslation(doodadMat, position);
    mat4.scale(doodadMat, doodadMat, [scale, scale, scale]);
    mat4.rotateZ(doodadMat, doodadMat, MathConstants.DEG_TO_RAD * rotation[2]);
    mat4.rotateY(doodadMat, doodadMat, MathConstants.DEG_TO_RAD * rotation[1]);
    mat4.rotateX(doodadMat, doodadMat, MathConstants.DEG_TO_RAD * rotation[0]);
    mat4.mul(doodadMat, doodadMat, placementSpaceFromModelSpace);
    mat4.mul(doodadMat, adtSpaceFromPlacementSpace, doodadMat);
    const fileId = doodad.name_id;
    doodad.free();
    return new DoodadData(fileId, doodadMat, null);
  }

  static fromWmoDoodad(doodad: WowDoodadDef, modelIds: Uint32Array, wmoDefModelMatrix: mat4): DoodadData {
    const doodadPos = doodad.position;
    let position: vec3 = [doodadPos.x, doodadPos.y, doodadPos.z];
    doodadPos.free();
    const doodadRot = doodad.orientation;
    let rotation: quat = [doodadRot.x, doodadRot.y, doodadRot.z, doodadRot.w];
    doodadRot.free();
    let scale = doodad.scale;
    const doodadColor = doodad.color;
    let color = [doodadColor.g, doodadColor.b, doodadColor.r, doodadColor.a]; // BRGA
    doodadColor.free();
    const modelId = modelIds[doodad.name_index];
    let doodadMat = mat4.create();
    setMatrixTranslation(doodadMat, position);
    const rotMat = mat4.fromQuat(mat4.create(), rotation as quat);
    mat4.mul(doodadMat, doodadMat, rotMat);
    mat4.scale(doodadMat, doodadMat, [scale, scale, scale]);
    mat4.mul(doodadMat, wmoDefModelMatrix, doodadMat);
    doodad.free();
    return new DoodadData(modelId, doodadMat, color);
  }

  public setBoundingBoxFromModel(model: ModelData) {
    this.worldAABB.transform(model.modelAABB, this.modelMatrix);
  }
}

export class LazyWorldData {
  public adts: AdtData[] = [];
  private loadedAdtFileIds: number[] = [];
  public globalWmo: WmoData | null = null;
  public globalWmoDef: WmoDefinition | null = null;
  public hasBigAlpha: boolean;
  public hasHeightTexturing: boolean;
  public adtFileIds: WowMapFileDataIDs[] = [];
  public loading = false;

  constructor(public fileId: number, public startAdtCoords: [number, number], public adtRadius = 2, private dataFetcher: DataFetcher, public cache: WowCache) {
  }

  public async load() {
    const wdt = await fetchFileByID(this.fileId, this.dataFetcher, rust.WowWdt.new);
    this.adtFileIds = wdt.get_all_map_data();
    const [centerX, centerY] = this.startAdtCoords;
    for (let x = centerX - this.adtRadius; x <= centerX + this.adtRadius; x++) {
      for (let y = centerY - this.adtRadius; y <= centerY + this.adtRadius; y++) {
        const maybeAdt = await this.ensureAdtLoaded(x, y);
        if (maybeAdt) {
          this.adts.push(maybeAdt);
        }
      }
    }
    this.hasBigAlpha = wdt.adt_has_big_alpha();
    this.hasHeightTexturing = wdt.adt_has_height_texturing();
    wdt.free();
  }

  public onEnterAdt([centerX, centerY]: [number, number], scene: WdtScene) {
    if (this.loading) {
      return;
    }
    setTimeout(async () => {
      this.loading = true;
      console.log(`loading area around ${centerX}, ${centerY}`)
      for (let x = centerX - this.adtRadius; x <= centerX + this.adtRadius; x++) {
        for (let y = centerY - this.adtRadius; y <= centerY + this.adtRadius; y++) {
          const maybeAdt = await this.ensureAdtLoaded(x, y);
          if (maybeAdt) {
            scene.setupAdt(maybeAdt);
            this.adts.push(maybeAdt);
          }
        }
      }
      this.loading = false;
    }, 0);
  }

  public async ensureAdtLoaded(x: number, y: number): Promise<AdtData | undefined> {
    const fileIDs = this.adtFileIds[y * 64 + x];
    if (this.loadedAdtFileIds.includes(fileIDs.root_adt)) {
      return undefined;
    }
    console.log(`loading coords ${x}, ${y}`)
    if (fileIDs.root_adt === 0) {
      console.error(`null ADTs in a non-global-WMO WDT`);
      return undefined;
    }

    const wowAdt = rust.WowAdt.new(await fetchDataByFileID(fileIDs.root_adt, this.dataFetcher));
    wowAdt.append_obj_adt(await fetchDataByFileID(fileIDs.obj0_adt, this.dataFetcher));
    if (fileIDs.obj1_adt !== 0) {
      wowAdt.append_lod_obj_adt(await fetchDataByFileID(fileIDs.obj1_adt, this.dataFetcher));
    }
    wowAdt.append_tex_adt(await fetchDataByFileID(fileIDs.tex0_adt, this.dataFetcher));

    const adt = new AdtData(fileIDs.root_adt, wowAdt);
    await adt.load(this.dataFetcher, this.cache);

    adt.hasBigAlpha = this.hasBigAlpha;
    adt.hasHeightTexturing = this.hasHeightTexturing;

    this.loadedAdtFileIds.push(fileIDs.root_adt);
    return adt;
  }

  public getAdtCoords(fileId: number): [number, number] | undefined {
    for (let i=0; i < this.adtFileIds.length; i++) {
      if (this.adtFileIds[i].root_adt === fileId) {
        const x = i % 64;
        const y = Math.floor(i / 64);
        return [x, y];
      }
    }
    return undefined;
  }
}

export class WorldData {
  public adts: AdtData[] = [];
  public globalWmo: WmoData | null = null;
  public globalWmoDef: WmoDefinition | null = null;
  public cache: any;

  constructor(public fileId: number) {
  }

  public async load(dataFetcher: DataFetcher, cache: WowCache) {
    const wdt = await fetchFileByID(this.fileId, dataFetcher, rust.WowWdt.new);
    const hasBigAlpha = wdt.adt_has_big_alpha();
    const hasHeightTexturing = wdt.adt_has_height_texturing();
    if (wdt.wdt_uses_global_map_obj()) {
      const def = wdt.global_wmo!;
      this.globalWmo = await cache.loadWmo(def.name_id);
      this.globalWmoDef = WmoDefinition.fromGlobalDefinition(def, this.globalWmo);
    } else {
      const adtFileIDs = wdt.get_loaded_map_data();
      for (let fileIDs of adtFileIDs) {
        if (fileIDs.root_adt === 0) {
          throw new Error(`null ADTs in a non-global-WMO WDT`);
        }
        const wowAdt = rust.WowAdt.new(await fetchDataByFileID(fileIDs.root_adt, dataFetcher));
        wowAdt.append_obj_adt(await fetchDataByFileID(fileIDs.obj0_adt, dataFetcher));
        if (fileIDs.obj1_adt !== 0) {
          wowAdt.append_lod_obj_adt(await fetchDataByFileID(fileIDs.obj1_adt, dataFetcher));
        }
        wowAdt.append_tex_adt(await fetchDataByFileID(fileIDs.tex0_adt, dataFetcher));

        const adt = new AdtData(fileIDs.root_adt, wowAdt);
        await adt.load(dataFetcher, cache);

        adt.hasBigAlpha = hasBigAlpha;
        adt.hasHeightTexturing = hasHeightTexturing;

        this.adts.push(adt);
      }
    }
    wdt.free();
  }
}
