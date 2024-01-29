import { vec3, mat4, vec4, quat } from "gl-matrix";
import { WowM2, WowSkin, WowBlp, WowSkinSubmesh, WowModelBatch, WowAdt, WowAdtChunkDescriptor, WowDoodad, WowWdt, WowWmo, WowWmoGroup, WowWmoMaterialInfo, WowWmoMaterialBatch, WowQuat, WowVec3, WowDoodadDef, WowWmoMaterial, WowAdtWmoDefinition, WowGlobalWmoDefinition, WowM2Material, WowM2MaterialFlags, WowM2BlendingMode, WowM2AnimationManager, WowVec4, WowMapFileDataIDs, WowLightDatabase, WowLightingData } from "../../rust/pkg";
import { DataFetcher } from "../DataFetcher.js";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers.js";
import { GfxDevice, GfxVertexBufferDescriptor, GfxIndexBufferDescriptor, GfxBufferUsage, GfxBlendMode, GfxCullMode, GfxBlendFactor, GfxChannelWriteMask, GfxCompareMode } from "../gfx/platform/GfxPlatform.js";
import { rust } from "../rustlib.js";
import { fetchFileByID, fetchDataByFileID } from "./util.js";
import { MathConstants, setMatrixTranslation } from "../MathHelpers.js";
import { adtSpaceFromModelSpace, adtSpaceFromPlacementSpace, placementSpaceFromModelSpace, noclipSpaceFromPlacementSpace, noclipSpaceFromModelSpace, noclipSpaceFromAdtSpace } from "./scenes.js";
import { AABB } from "../Geometry.js";
import { GfxRenderInst, GfxRendererLayer, makeSortKey, setSortKeyDepth } from "../gfx/render/GfxRenderInstManager.js";
import { BaseProgram, ModelProgram } from "./program.js";
import { fillMatrix4x4, fillVec4, fillVec4v } from "../gfx/helpers/UniformBufferHelpers.js";
import { AttachmentStateSimple, setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers.js";
import { reverseDepthForCompareMode } from "../gfx/helpers/ReversedDepthHelpers.js";
import { computeViewSpaceDepthFromWorldSpaceAABB } from "../Camera";

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

  public setGlobalLightingData(renderInst: GfxRenderInst, coords: vec3, time: number) {
    const lightingData = this.db.get_lighting_data(this.mapId, coords[0], coords[1], coords[2], time);
    const mainLightingData = lightingData.inner_light.light_data[0];
    const mainLightingParams = lightingData.inner_light.light_params[0];
    const numVec3s = 16;
    const numVec4s = 3;
    let offset = renderInst.allocateUniformBuffer(BaseProgram.ub_GlobalLightParams, numVec3s * 12 + numVec4s * 16);
    const uniformBuf = renderInst.mapUniformBufferF32(ModelProgram.ub_MaterialParams);
    offset += fillColor(uniformBuf, offset, mainLightingData.direct_color);
    offset += fillColor(uniformBuf, offset, mainLightingData.ambient_color);
    offset += fillColor(uniformBuf, offset, mainLightingData.sky_top_color);
    offset += fillColor(uniformBuf, offset, mainLightingData.sky_middle_color);
    offset += fillColor(uniformBuf, offset, mainLightingData.sky_band1_color);
    offset += fillColor(uniformBuf, offset, mainLightingData.sky_band2_color);
    offset += fillColor(uniformBuf, offset, mainLightingData.sky_fog_color);
    offset += fillColor(uniformBuf, offset, mainLightingData.sun_color);
    offset += fillColor(uniformBuf, offset, mainLightingData.cloud_sun_color);
    offset += fillColor(uniformBuf, offset, mainLightingData.cloud_emissive_color);
    offset += fillColor(uniformBuf, offset, mainLightingData.cloud_layer1_ambient_color);
    offset += fillColor(uniformBuf, offset, mainLightingData.cloud_layer2_ambient_color);
    offset += fillColor(uniformBuf, offset, mainLightingData.ocean_close_color);
    offset += fillColor(uniformBuf, offset, mainLightingData.ocean_far_color);
    offset += fillColor(uniformBuf, offset, mainLightingData.river_close_color);
    offset += fillColor(uniformBuf, offset, mainLightingData.river_far_color);
    offset += fillColor(uniformBuf, offset, mainLightingData.shadow_opacity);
    offset += fillVec4(uniformBuf, offset,
      mainLightingData.fog_end,
      mainLightingData.fog_scaler,
      0,
      0
    );
    offset += fillVec4(uniformBuf, offset,
      mainLightingParams.water_shallow_alpha,
      mainLightingParams.water_deep_alpha,
      mainLightingParams.ocean_shallow_alpha,
      mainLightingParams.ocean_deep_alpha,
    );
    offset += fillVec4(uniformBuf, offset,
      mainLightingParams.glow,
      mainLightingParams.highlight_sky ? 1 : 0,
      0,
      0
    );
  }
}

function fillColor(buf: Float32Array, offset: number, color: number): number {
  buf[offset + 0] = (color & 0xff) / 255;
  buf[offset + 1] = ((color >> 8) & 0xff) / 255;
  buf[offset + 2] = ((color >> 16) & 0xff) / 255;
  offset += 3;
  return offset;
}

abstract class Loadable {
  public abstract load(dataFetcher: DataFetcher, cache: WowCache): Promise<void>
}

export class WowCache {
  public models: Map<number, ModelData> = new Map();
  public wmos: Map<number, WmoData> = new Map();
  public wmoGroups: Map<number, WmoGroupData> = new Map();
  public blps: Map<number, WowBlp> = new Map();

  constructor(public dataFetcher: DataFetcher) {
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
  public m2: WowM2;
  public skins: WowSkin[] = [];
  public blpIds: number[] = [];
  public vertexColors: WowVec4[] = [];
  public textureWeights: Float32Array;
  public textureTransforms: mat4[] = [];
  public materials: [WowM2BlendingMode, WowM2MaterialFlags][] = [];
  public animationManager: WowM2AnimationManager;
  public textureLookupTable: Uint16Array;
  public textureTransformsLookupTable: Uint16Array;
  public transparencyLookupTable: Uint16Array;

  constructor(public fileId: number) {
  }

  public async load(dataFetcher: DataFetcher, cache: WowCache): Promise<undefined> {
    this.m2 = await fetchFileByID(this.fileId, dataFetcher, rust.WowM2.new);
    this.textureLookupTable = this.m2.get_texture_lookup_table();
    this.textureTransformsLookupTable = this.m2.get_texture_transforms_lookup_table();
    this.transparencyLookupTable = this.m2.get_transparency_lookup_table();
    this.animationManager = this.m2.get_animation_manager();
    for (let txid of this.m2.texture_ids) {
      if (txid === 0) continue;
      try {
        await cache.loadBlp(txid);
        this.blpIds.push(txid);
      } catch (e) {
        console.error(`failed to load BLP: ${e}`)
      }
    }

    this.materials = this.m2.get_materials().map(mat => {
      return [mat.blending_mode, rust.WowM2MaterialFlags.new(mat.flags)];
    })

    for (let skid of this.m2.skin_ids) {
      this.skins.push(await fetchFileByID(skid, dataFetcher, rust.WowSkin.new));
    }
  }

  public updateAnimation(deltaTime: number) {
    this.animationManager.update(deltaTime);
    this.vertexColors = this.animationManager.calculated_colors!;
    this.textureWeights = this.animationManager.calculated_transparencies!;

    const rotations = this.animationManager.calculated_texture_rotations!;
    const translations = this.animationManager.calculated_texture_translations!;
    const scalings = this.animationManager.calculated_texture_scalings!;
    const transforms: mat4[] = [];
    const pivot: vec3 = [0.5, 0.5, 0];
    const antiPivot: vec3 = [-0.5, -0.5, 0];
    for (let i = 0; i < rotations.length; i++) {
      const transform = mat4.identity(mat4.create());

      mat4.translate(transform, transform, pivot);
      mat4.fromQuat(transform, [rotations[i].x, rotations[i].y, rotations[i].z, rotations[i].w]);
      mat4.translate(transform, transform, antiPivot);

      mat4.translate(transform, transform, pivot);
      mat4.scale(transform, transform, [scalings[i].x, scalings[i].y, scalings[i].z]);
      mat4.translate(transform, transform, antiPivot);

      mat4.translate(transform, transform, [translations[i].x, translations[i].y, translations[i].z]);
      transforms.push(transform);
    }
    this.textureTransforms = transforms;
  }
}

export class WmoBatchData {
  public indexStart: number;
  public indexCount: number;
  public materialId: number;

  constructor(batch: WowWmoMaterialBatch) {
    this.indexStart = batch.start_index;
    this.indexCount = batch.index_count;
    if (batch.use_material_id_large > 0) {
      this.materialId = batch.material_id_large;
    } else {
      this.materialId = batch.material_id;
    }
  }
}

export class WmoGroupData {
  public group: WowWmoGroup;

  constructor(public fileId: number) {
  }

  public getBatches(): WmoBatchData[] {
    const batches: WmoBatchData[] = [];
    for (let batch of this.group.batches) {
      batches.push(new WmoBatchData(batch))
    }
    return batches;
  }

  public getVertexBuffers(device: GfxDevice): GfxVertexBufferDescriptor[] {
    return [
      { byteOffset: 0, buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, this.group.vertices.buffer) },
      { byteOffset: 0, buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, this.group.normals.buffer) },
      { byteOffset: 0, buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, this.group.uvs.buffer) },
    ];
  }

  public getIndexBuffer(device: GfxDevice): GfxIndexBufferDescriptor {
    return{ byteOffset: 0, buffer: makeStaticDataBuffer(device, GfxBufferUsage.Index, this.group.indices.buffer) }
  }

  public async load(dataFetcher: DataFetcher, cache: WowCache): Promise<undefined> {
    this.group = await fetchFileByID(this.fileId, dataFetcher, rust.WowWmoGroup.new);
  }
}

export class WmoData {
  public wmo: WowWmo;
  public groupIds: number[] = [];
  public blpIds: number[] = [];
  public materials: WowWmoMaterial[] = [];
  public modelIds: Uint32Array;

  constructor(public fileId: number) {
  }

  public async load(dataFetcher: DataFetcher, cache: WowCache): Promise<void> {
    this.wmo = await fetchFileByID(this.fileId, dataFetcher, rust.WowWmo.new);

    for (let tex of this.wmo.textures) {
      this.materials.push(tex);
      for (let texId of [tex.texture_1, tex.texture_2, tex.texture_3]) {
        if (texId !== 0)
          await cache.loadBlp(texId)
      }
    }

    this.modelIds = this.wmo.doodad_file_ids;
    for (let modelId of this.modelIds) {
      if (modelId !== 0)
        await cache.loadModel(modelId)
    }

    for (let gfid of this.wmo.group_file_ids) {
      await cache.loadWmoGroup(gfid);
      this.groupIds.push(gfid);
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
    this.indexBuffer = skin.get_indices();
  }
}

export class ModelRenderPass {
  public vertexShaderId: number;
  public fragmentShaderId: number;
  public blendMode: WowM2BlendingMode;
  public materialFlags: WowM2MaterialFlags;
  public submesh: WowSkinSubmesh;
  public tex0: number;
  public tex1: number | null;
  public tex2: number | null;
  public tex3: number | null;
  public normalMat: mat4;

  constructor(public batch: WowModelBatch, public skin: WowSkin, public model: ModelData) {
    this.fragmentShaderId = batch.get_pixel_shader();
    this.vertexShaderId = batch.get_vertex_shader();
    this.submesh = skin.submeshes[batch.skin_submesh_index];
    [this.blendMode, this.materialFlags] = model.materials[this.batch.material_index];
    this.tex0 = this.getBlpId(0)!;
    this.tex1 = this.getBlpId(1);
    this.tex2 = this.getBlpId(2);
    this.tex3 = this.getBlpId(3);
    this.normalMat = this.createNormalMat();
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

  private createNormalMat(): mat4 {
    const result = mat4.create();
    mat4.identity(result);// TODO
    return result;
  }

  private getBlpId(n: number): number | null {
    if (n < this.batch.texture_count) {
      const i = this.model.textureLookupTable[this.batch.texture_combo_index + n];
      return this.model.blpIds[i];
    }
    return null;
  }

  private getCurrentVertexColor(): vec4 {
    const vertexColor = this.model.vertexColors[this.batch.color_index];
    if (vertexColor) {
      return [vertexColor.x, vertexColor.y, vertexColor.z, vertexColor.w];
    }
    return [1.0, 1.0, 1.0, 1.0];
  }

  // TODO eventually handle animation logic
  private getTextureTransform(texIndex: number): mat4 {
    const lookupIndex = this.batch.texture_transform_combo_index + texIndex;
    if (lookupIndex < this.model.textureTransformsLookupTable.length) {
      const transformIndex = this.model.textureTransformsLookupTable[lookupIndex];
      if (transformIndex < this.model.textureTransforms.length) {
        return this.model.textureTransforms[transformIndex];
      }
    }
    return mat4.identity(mat4.create())
  }

  private getTextureWeight(texIndex: number): number {
    const lookupIndex = this.batch.texture_weight_combo_index + texIndex;
    if (lookupIndex < this.model.transparencyLookupTable.length) {
      const transparencyIndex = this.model.transparencyLookupTable[lookupIndex];
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
    let offset = renderInst.allocateUniformBuffer(ModelProgram.ub_MaterialParams, (4 + 4 + 4 + 16 + 16 + 4 + 16) * 4);
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
    offset += fillMatrix4x4(uniformBuf, offset, this.normalMat);
  }
}

export class WmoDefinition {
  public modelMatrix: mat4;
  public worldSpaceAABB: AABB;
  public visible: boolean;
  public doodadsVisible: boolean;

  static fromAdtDefinition(def: WowAdtWmoDefinition) {
    const scale = def.scale / 1024;
    const position: vec3 = [
      def.position.x - 17066,
      def.position.y,
      def.position.z - 17066,
    ];
    const rotation: vec3 = [
      def.rotation.x,
      def.rotation.y,
      def.rotation.z,
    ];
    const aabb = new AABB(
      def.extents.min.x - 17066,
      def.extents.min.y,
      def.extents.min.z - 17066,
      def.extents.max.x - 17066,
      def.extents.max.y,
      def.extents.max.z - 17066,
    )
    return new WmoDefinition(def.name_id, def.doodad_set, scale, position, rotation, aabb);
  }

  static fromGlobalDefinition(def: WowGlobalWmoDefinition) {
    const scale = 1.0;
    const position: vec3 = [
      def.position.x - 17066,
      def.position.y,
      def.position.z - 17066,
    ];
    const rotation: vec3 = [
      def.rotation.x,
      def.rotation.y,
      def.rotation.z,
    ];
    const aabb = new AABB(
      def.extents.min.x - 17066,
      def.extents.min.y,
      def.extents.min.z - 17066,
      def.extents.max.x - 17066,
      def.extents.max.y,
      def.extents.max.z - 17066,
    )
    return new WmoDefinition(def.name_id, def.doodad_set, scale, position, rotation, aabb);
  }

  // AABB should be in placement space
  constructor(public wmoId: number, public doodadSet: number, scale: number, position: vec3, rotation: vec3, extents: AABB) {
    this.modelMatrix = mat4.create();
    setMatrixTranslation(this.modelMatrix, position);
    mat4.scale(this.modelMatrix, this.modelMatrix, [scale, scale, scale]);
    mat4.rotateZ(this.modelMatrix, this.modelMatrix, MathConstants.DEG_TO_RAD * rotation[2]);
    mat4.rotateY(this.modelMatrix, this.modelMatrix, MathConstants.DEG_TO_RAD * rotation[1]);
    mat4.rotateX(this.modelMatrix, this.modelMatrix, MathConstants.DEG_TO_RAD * rotation[0]);
    mat4.mul(this.modelMatrix, this.modelMatrix, placementSpaceFromModelSpace);
    mat4.mul(this.modelMatrix, adtSpaceFromPlacementSpace, this.modelMatrix);

    this.worldSpaceAABB = extents;
    this.visible = true;
    this.doodadsVisible = true;
  }
}

export class AdtData {
  public blpIds: number[] = [];
  public modelIds: number[] = [];
  public wmoIds: number[] = [];
  public wmoDefs: WmoDefinition[] = [];
  public hasBigAlpha: boolean;
  public hasHeightTexturing: boolean;

  constructor(public innerAdt: WowAdt) {
  }
  
  public async load(dataFetcher: DataFetcher, cache: WowCache) {
      for (let blpId of this.innerAdt.get_texture_file_ids()) {
        await cache.loadBlp(blpId);
      }

      for (let modelId of this.innerAdt.get_model_file_ids()) {
        await cache.loadModel(modelId);
      }

      for (let wmoDef of this.innerAdt.map_object_defs) {
        this.wmoDefs.push(WmoDefinition.fromAdtDefinition(wmoDef));
        await cache.loadWmo(wmoDef.name_id);
      }
  }

  public setWorldFlags(wdt: WowWdt) {
    this.hasBigAlpha = wdt.adt_has_big_alpha();
    this.hasHeightTexturing = wdt.adt_has_height_texturing();

    if (this.hasHeightTexturing) {
      console.log('height texturing!', this);
    }
  }

  public getBufsAndChunks(device: GfxDevice): [GfxVertexBufferDescriptor, GfxIndexBufferDescriptor, WowAdtChunkDescriptor[], AABB] {
    const renderResult = this.innerAdt.get_render_result(this.hasBigAlpha, this.hasHeightTexturing);
    const vertexBuffer = {
      buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, renderResult.vertex_buffer.buffer),
      byteOffset: 0,
    };
    const indexBuffer = {
      buffer: makeStaticDataBuffer(device, GfxBufferUsage.Index, renderResult.index_buffer.buffer),
      byteOffset: 0,
    };
    const adtChunks = renderResult.chunks;
    const extents = renderResult.extents;
    const aabb = new AABB(
      extents.min.x,
      extents.min.y,
      extents.min.z,
      extents.max.x,
      extents.max.y,
      extents.max.z,
    );
    aabb.transform(aabb, noclipSpaceFromAdtSpace);
    return [vertexBuffer, indexBuffer, adtChunks, aabb];
  }
}

export class DoodadData {
  public visible = true;

  constructor(public modelId: number, public modelMatrix: mat4, public color: number[] | null) {
  }

  static fromAdtDoodad(doodad: WowDoodad): DoodadData {
    let position: vec3 = [doodad.position.x - 17066, doodad.position.y, doodad.position.z - 17066];
    let rotation: vec3 = [doodad.rotation.x, doodad.rotation.y, doodad.rotation.z];
    let scale = doodad.scale / 1024;
    const doodadMat = mat4.create();
    setMatrixTranslation(doodadMat, position);
    mat4.scale(doodadMat, doodadMat, [scale, scale, scale]);
    mat4.rotateZ(doodadMat, doodadMat, MathConstants.DEG_TO_RAD * rotation[2]);
    mat4.rotateY(doodadMat, doodadMat, MathConstants.DEG_TO_RAD * rotation[1]);
    mat4.rotateX(doodadMat, doodadMat, MathConstants.DEG_TO_RAD * rotation[0]);
    mat4.mul(doodadMat, doodadMat, placementSpaceFromModelSpace);
    mat4.mul(doodadMat, adtSpaceFromPlacementSpace, doodadMat);
    return new DoodadData(doodad.name_id, doodadMat, null);
  }

  static fromWmoDoodad(doodad: WowDoodadDef, wmo: WmoData): DoodadData {
    let position: vec3 = [doodad.position.x, doodad.position.y, doodad.position.z];
    let rotation: quat = [doodad.orientation.x, doodad.orientation.y, doodad.orientation.z, doodad.orientation.w];
    let scale = doodad.scale;
    let color = [doodad.color.g, doodad.color.b, doodad.color.r, doodad.color.a]; // BRGA
    const modelId = wmo.modelIds[doodad.name_index];
    let doodadMat = mat4.create();
    setMatrixTranslation(doodadMat, position);
    const rotMat = mat4.fromQuat(mat4.create(), rotation as quat);
    mat4.mul(doodadMat, doodadMat, rotMat);
    mat4.scale(doodadMat, doodadMat, [scale, scale, scale]);
    return new DoodadData(modelId, doodadMat, color);
  }
}

export class LazyWorldData {
  public wdt: WowWdt;
  public adts: AdtData[] = [];
  private loadedAdtFileIds: number[] = [];
  public globalWmo: WmoData | null = null;
  public globalWmoDef: WmoDefinition | null = null;
  private adtFileIds: WowMapFileDataIDs[] = [];

  constructor(public fileId: number, public startAdtCoords: [number, number], public adtRadius = 1) {
  }

  public async load(dataFetcher: DataFetcher, cache: WowCache) {
    this.wdt = await fetchFileByID(this.fileId, dataFetcher, rust.WowWdt.new);
    this.adtFileIds = this.wdt.get_all_map_data();
    const [adtX, adtY] = this.startAdtCoords;
    for (let x = adtX - this.adtRadius; x <= adtX + this.adtRadius; x++) {
      for (let y = adtY - this.adtRadius; y <= adtY + this.adtRadius; y++) {
        await this.loadAdt(x, y, dataFetcher, cache);
      }
    }
  }

  public async loadAdt(x: number, y: number, dataFetcher: DataFetcher, cache: WowCache) {
    console.log(`loading coords ${x}, ${y}`)
    const fileIDs = this.adtFileIds[y * 64 + x];
    if (fileIDs.root_adt === 0) {
      console.error(`null ADTs in a non-global-WMO WDT`);
      return;
    }

    // TODO handle obj1 (LOD) adts
    const wowAdt = rust.WowAdt.new(await fetchDataByFileID(fileIDs.root_adt, dataFetcher));
    wowAdt.append_obj_adt(await fetchDataByFileID(fileIDs.obj0_adt, dataFetcher));
    wowAdt.append_tex_adt(await fetchDataByFileID(fileIDs.tex0_adt, dataFetcher));

    const adt = new AdtData(wowAdt);
    await adt.load(dataFetcher, cache);
    adt.setWorldFlags(this.wdt);

    this.adts.push(adt);
    this.loadedAdtFileIds.push(fileIDs.root_adt);
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
  public wdt: WowWdt;
  public adts: AdtData[] = [];
  public globalWmo: WmoData | null = null;
  public globalWmoDef: WmoDefinition | null = null;
  public cache: any;

  constructor(public fileId: number) {
  }

  public async load(dataFetcher: DataFetcher, cache: WowCache) {
    this.wdt = await fetchFileByID(this.fileId, dataFetcher, rust.WowWdt.new);
    if (this.wdt.wdt_uses_global_map_obj()) {
      const globalWmo = this.wdt.global_wmo!;
      this.globalWmo = await cache.loadWmo(globalWmo.name_id);
      this.globalWmoDef = WmoDefinition.fromGlobalDefinition(globalWmo);
    } else {
      const adtFileIDs = this.wdt.get_loaded_map_data();
      for (let fileIDs of adtFileIDs) {
        if (fileIDs.root_adt === 0) {
          throw new Error(`null ADTs in a non-global-WMO WDT`);
        }
        // TODO handle obj1 (LOD) adts
        const wowAdt = rust.WowAdt.new(await fetchDataByFileID(fileIDs.root_adt, dataFetcher));
        wowAdt.append_obj_adt(await fetchDataByFileID(fileIDs.obj0_adt, dataFetcher));
        wowAdt.append_tex_adt(await fetchDataByFileID(fileIDs.tex0_adt, dataFetcher));

        const adt = new AdtData(wowAdt);
        await adt.load(dataFetcher, cache);
        adt.setWorldFlags(this.wdt);

        this.adts.push(adt);
      }
    }
  }
}
