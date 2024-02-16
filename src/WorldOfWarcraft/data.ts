import { vec3, mat4, vec4, quat } from "gl-matrix";
import { WowM2, WowSkin, WowBlp, WowSkinSubmesh, WowModelBatch, WowAdt, WowAdtChunkDescriptor, WowDoodad, WowWdt, WowWmo, WowWmoGroup, WowWmoMaterialInfo, WowWmoMaterialBatch, WowQuat, WowVec3, WowDoodadDef, WowWmoMaterial, WowAdtWmoDefinition, WowGlobalWmoDefinition, WowM2Material, WowM2MaterialFlags, WowM2BlendingMode, WowVec4, WowMapFileDataIDs, WowLightDatabase, WowWmoMaterialVertexShader, WowWmoMaterialPixelShader, WowWmoMaterialFlags, WowWmoGroupFlags, WowLightResult, WowWmoGroupInfo } from "../../rust/pkg";
import { DataFetcher } from "../DataFetcher.js";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers.js";
import { GfxDevice, GfxVertexBufferDescriptor, GfxIndexBufferDescriptor, GfxBufferUsage, GfxBlendMode, GfxCullMode, GfxBlendFactor, GfxChannelWriteMask, GfxCompareMode, GfxFormat, GfxVertexBufferFrequency, GfxInputLayout, GfxInputLayoutBufferDescriptor, GfxVertexAttributeDescriptor } from "../gfx/platform/GfxPlatform.js";
import { rust } from "../rustlib.js";
import { fetchFileByID, fetchDataByFileID, getFilePath } from "./util.js";
import { MathConstants, setMatrixTranslation } from "../MathHelpers.js";
import { adtSpaceFromModelSpace, adtSpaceFromPlacementSpace, placementSpaceFromModelSpace, noclipSpaceFromPlacementSpace, noclipSpaceFromModelSpace, noclipSpaceFromAdtSpace, modelSpaceFromAdtSpace, MapArray } from "./scenes.js";
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
  public textureRotations: WowQuat[] = [];
  public textureScalings: WowVec3[] = [];
  public textureTranslations: WowVec3[] = [];
  public textureTransforms: mat4[] = [];
  public materials: [WowM2BlendingMode, WowM2MaterialFlags][] = [];
  public modelAABB: AABB;

  constructor(public fileId: number) {
  }

  public async load(dataFetcher: DataFetcher, cache: WowCache): Promise<undefined> {
    this.m2 = await fetchFileByID(this.fileId, dataFetcher, rust.WowM2.new);
    for (let txid of this.m2.texture_ids) {
      if (txid === 0) continue;
      try {
        await cache.loadBlp(txid);
        this.blpIds.push(txid);
      } catch (e) {
        console.error(`failed to load BLP: ${e}`)
      }
    }
    this.textureWeights = new Float32Array(this.m2.get_num_texture_weights());

    const aabb = this.m2.get_bounding_box();
    this.modelAABB = new AABB(
      aabb.min.x,
      aabb.min.y,
      aabb.min.z,
      aabb.max.x,
      aabb.max.y,
      aabb.max.z,
    );

    this.materials = this.m2.materials.map(mat => {
      return [mat.blending_mode, rust.WowM2MaterialFlags.new(mat.flags)];
    })

    for (let skid of this.m2.skin_ids) {
      this.skins.push(await fetchFileByID(skid, dataFetcher, rust.WowSkin.new));
    }
  }

  public updateAnimation(deltaTime: number) {
    this.m2.update_animations(
      deltaTime / 10,
      this.textureWeights,
      this.textureTranslations,
      this.textureRotations,
      this.textureScalings,
      this.vertexColors
    );

    const transforms: mat4[] = [];
    const pivot: vec3 = [0.5, 0.5, 0];
    const antiPivot: vec3 = [-0.5, -0.5, 0];
    for (let i = 0; i < this.textureRotations.length; i++) {
      const transform = mat4.identity(mat4.create());

      mat4.translate(transform, transform, pivot);
      const rotation: vec4 = [this.textureRotations[i].x, this.textureRotations[i].y, this.textureRotations[i].z, this.textureRotations[i].w];
      mat4.fromQuat(transform, rotation);
      mat4.translate(transform, transform, antiPivot);

      mat4.translate(transform, transform, pivot);
      const scaling: vec3 = [this.textureScalings[i].x, this.textureScalings[i].y, this.textureScalings[i].z];
      mat4.scale(transform, transform, scaling);
      mat4.translate(transform, transform, antiPivot);

      const translation: vec3 = [this.textureTranslations[i].x, this.textureTranslations[i].y, this.textureTranslations[i].z];
      mat4.translate(transform, transform, translation);
      transforms.push(transform);
    }
    this.textureTransforms = transforms;
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
  public normalMat: mat4;
  public visible = true;

  constructor(batch: WowWmoMaterialBatch, materials: WowWmoMaterial[]) {
    this.indexStart = batch.start_index;
    this.indexCount = batch.index_count;
    if (batch.use_material_id_large > 0) {
      this.materialId = batch.material_id_large;
    } else {
      this.materialId = batch.material_id;
    }
    this.material = materials[this.materialId];
    this.materialFlags = rust.WowWmoMaterialFlags.new(this.material.flags);
    this.vertexShader = this.material.get_vertex_shader();
    this.pixelShader = this.material.get_pixel_shader();

    this.normalMat = mat4.create();
    mat4.identity(this.normalMat);
  }

  public setMegaStateFlags(renderInst: GfxRenderInst) {
    let settings = {
      cullMode: this.materialFlags.unculled ? GfxCullMode.None : GfxCullMode.Back,
      depthWrite: this.material.blend_mode <= 1,
    };
    // TODO setSortKeyDepth based on distance to transparent object
    switch (this.material.blend_mode) {
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
}

export class WmoGroupData {
  public group: WowWmoGroup;
  public flags: WowWmoGroupFlags;
  public doodadRefs: Uint16Array;
  public visible = true;

  constructor(public fileId: number) {
  }

  public getBatches(materials: WowWmoMaterial[]): WmoBatchData[] {
    const batches: WmoBatchData[] = [];
    for (let batch of this.group.batches) {
      batches.push(new WmoBatchData(batch, materials))
    }
    return batches;
  }

  public getAmbientColor(wmoData: WmoData, doodadSetId: number): vec4 {
    let color: vec4 = [0, 0, 0, 0];
    if (!this.flags.exterior && !this.flags.exterior_lit) {
      let colorVec3 = this.group.replacement_for_header_color;
      if (!colorVec3) {
        colorVec3 = wmoData.wmo.get_ambient_color(doodadSetId);
      }
      color = [
        colorVec3.r / 255.0,
        colorVec3.g / 255.0,
        colorVec3.b / 255.0,
        1.0,
      ];
    }
    return color;
  }

  public getVertexBuffers(device: GfxDevice): GfxVertexBufferDescriptor[] {
    return [
      { byteOffset: 0, buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, this.group.vertices.buffer) },
      { byteOffset: 0, buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, this.group.normals.buffer) },
      { byteOffset: 0, buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, this.group.uvs.buffer) },
      { byteOffset: 0, buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, this.group.colors.buffer) },
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
    for (let i=0; i<this.group.num_uv_bufs; i++) {
      vertexAttributeDescriptors.push({
        location: WmoProgram.a_TexCoord0 + i,
        bufferIndex: 2,
        bufferByteOffset: 8 * i * this.group.num_vertices,
        format: GfxFormat.F32_RG,
      });
    }
    for (let i=0; i<this.group.num_color_bufs; i++) {
      vertexAttributeDescriptors.push({
        location: WmoProgram.a_Color0 + i,
        bufferIndex: 3,
        bufferByteOffset: 4 * i * this.group.num_vertices,
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
    return { byteOffset: 0, buffer: makeStaticDataBuffer(device, GfxBufferUsage.Index, this.group.indices.buffer) }
  }

  public async load(dataFetcher: DataFetcher, cache: WowCache): Promise<undefined> {
    this.group = await fetchFileByID(this.fileId, dataFetcher, rust.WowWmoGroup.new);
    this.flags = rust.WowWmoGroupFlags.new(this.group.header.flags);
    this.doodadRefs = this.group.doodad_refs;
  }
}

export class WmoData {
  public wmo: WowWmo;
  public groups: WmoGroupData[] = [];
  public groupInfos: WowWmoGroupInfo[] = [];
  public groupAABBs: AABB[] = [];
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
        if (texId !== 0) {
          try {
            await cache.loadBlp(texId)
          } catch (e) {
            console.error(`failed to fetch BLP: ${e}`);
          }
        }
      }
    }

    this.modelIds = this.wmo.doodad_file_ids;
    for (let modelId of this.modelIds) {
      if (modelId !== 0)
        await cache.loadModel(modelId)
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
    this.indexBuffer = skin.indices;
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
      const i = this.model.m2.lookup_texture(this.batch.texture_combo_index + n)!;
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
    const transformIndex = this.model.m2.lookup_texture_transform(lookupIndex);
    if (transformIndex !== undefined) {
      if (transformIndex < this.model.textureTransforms.length) {
        return this.model.textureTransforms[transformIndex];
      }
    }
    return mat4.identity(mat4.create())
  }

  private getTextureWeight(texIndex: number): number {
    const lookupIndex = this.batch.texture_weight_combo_index + texIndex;
    const transparencyIndex = this.model.m2.lookup_transparency(lookupIndex);
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
    offset += fillMatrix4x4(uniformBuf, offset, this.normalMat);
  }
}

export class WmoDefinition {
  public modelMatrix: mat4 = mat4.create();
  public worldSpaceAABB: AABB = new AABB();
  public groupDefAABBs: Map<number, AABB> = new Map();
  public visible = true;
  public doodads: DoodadData[] = [];
  public groupIdToVisibility: Map<number, { visible: boolean }> = new Map();
  public groupIdToDoodadIndices: MapArray<number, number> = new MapArray();
  public groupAmbientColors: Map<number, vec4> = new Map();

  public setVisible(visible: boolean) {
    this.visible = visible;
    for (let doodad of this.doodads) {
      doodad.setVisible(visible);
    }
    for (let groupId of this.groupIdToVisibility.keys()) {
      this.groupIdToVisibility.set(groupId, { visible });
    }
  }

  static fromAdtDefinition(def: WowAdtWmoDefinition, wmo: WmoData) {
    const scale = def.scale / 1024;
    const position: vec3 = [
      def.position.x - MAP_SIZE,
      def.position.y,
      def.position.z - MAP_SIZE,
    ];
    const rotation: vec3 = [
      def.rotation.x,
      def.rotation.y,
      def.rotation.z,
    ];
    const aabb = new AABB(
      def.extents.min.x - MAP_SIZE,
      def.extents.min.y,
      def.extents.min.z - MAP_SIZE,
      def.extents.max.x - MAP_SIZE,
      def.extents.max.y,
      def.extents.max.z - MAP_SIZE,
    )
    return new WmoDefinition(def.name_id, wmo, def.unique_id, def.doodad_set, scale, position, rotation, aabb);
  }

  static fromGlobalDefinition(def: WowGlobalWmoDefinition, wmo: WmoData) {
    const scale = 1.0;
    const position: vec3 = [
      def.position.x - MAP_SIZE,
      def.position.y,
      def.position.z - MAP_SIZE,
    ];
    const rotation: vec3 = [
      def.rotation.x,
      def.rotation.y,
      def.rotation.z,
    ];
    const aabb = new AABB(
      def.extents.min.x - MAP_SIZE,
      def.extents.min.y,
      def.extents.min.z - MAP_SIZE,
      def.extents.max.x - MAP_SIZE,
      def.extents.max.y,
      def.extents.max.z - MAP_SIZE,
    )
    return new WmoDefinition(def.name_id, wmo, def.unique_id, def.doodad_set, scale, position, rotation, aabb);
  }

  // AABB should be in placement space
  constructor(public wmoId: number, wmo: WmoData, public uniqueId: number, public doodadSet: number, scale: number, position: vec3, rotation: vec3, extents: AABB) {
    setMatrixTranslation(this.modelMatrix, position);
    mat4.scale(this.modelMatrix, this.modelMatrix, [scale, scale, scale]);
    mat4.rotateZ(this.modelMatrix, this.modelMatrix, MathConstants.DEG_TO_RAD * rotation[2]);
    mat4.rotateY(this.modelMatrix, this.modelMatrix, MathConstants.DEG_TO_RAD * rotation[1]);
    mat4.rotateX(this.modelMatrix, this.modelMatrix, MathConstants.DEG_TO_RAD * rotation[0]);
    mat4.mul(this.modelMatrix, this.modelMatrix, placementSpaceFromModelSpace);
    mat4.mul(this.modelMatrix, adtSpaceFromPlacementSpace, this.modelMatrix);

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
    }

    this.worldSpaceAABB.transform(extents, adtSpaceFromPlacementSpace);
    this.visible = true;
  }

  public isWmoGroupVisible(groupFileId: number): boolean {
    // default to true
    let visibility = this.groupIdToVisibility.get(groupFileId) || { visible: true };
    return visibility.visible;
  }

  public setGroupVisible(groupId: number, visible: boolean) {
    this.groupIdToVisibility.set(groupId, { visible: visible });
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
  public blpIds: number[] = [];
  public worldSpaceAABB: AABB;
  public hasBigAlpha: boolean;
  public hasHeightTexturing: boolean;
  public lodLevel = 0;
  public lodData: AdtLodData[] = [];
  public visible = true;

  constructor(public fileId: number, public innerAdt: WowAdt) {
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
      for (let blpId of this.innerAdt.get_texture_file_ids()) {
        try {
          await cache.loadBlp(blpId);
        } catch (e) {
          console.error(`failed to load BLP ${e}`);
        }
      }

      for (let lodLevel of [0, 1]) {
        const lodData = new AdtLodData();

        for (let adtDoodad of this.innerAdt.get_doodads(lodLevel)) {
          lodData.doodads.push(DoodadData.fromAdtDoodad(adtDoodad));
        }

        for (let modelId of this.innerAdt.get_model_file_ids(lodLevel)) {
          await cache.loadModel(modelId);
          lodData.modelIds.push(modelId);
        }

        for (let wmoDef of this.innerAdt.get_wmo_defs(lodLevel)) {
          const wmo = await cache.loadWmo(wmoDef.name_id);
          lodData.wmoDefs.push(WmoDefinition.fromAdtDefinition(wmoDef, wmo));
        }
        if (lodLevel > 0 && lodData.modelIds.length > 0) {
          console.log(lodData);
        }

        this.lodData.push(lodData);
      }
  }

  public lodDoodads(): DoodadData[] {
    return this.lodData[this.lodLevel].doodads;
  }

  public lodWmoDefs(): WmoDefinition[] {
    return this.lodData[this.lodLevel].wmoDefs;
  }

  public setWorldFlags(wdt: WowWdt) {
    this.hasBigAlpha = wdt.adt_has_big_alpha();
    this.hasHeightTexturing = wdt.adt_has_height_texturing();

    if (this.hasHeightTexturing) {
      console.log('height texturing!', this);
    }
  }

  public getBufsAndChunks(device: GfxDevice): [GfxVertexBufferDescriptor, GfxIndexBufferDescriptor, WowAdtChunkDescriptor[]] {
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
    this.worldSpaceAABB = new AABB(
      extents.min.x,
      extents.min.y,
      extents.min.z,
      extents.max.x,
      extents.max.y,
      extents.max.z,
    );
    this.worldSpaceAABB.transform(this.worldSpaceAABB, noclipSpaceFromAdtSpace);
    this.worldSpaceAABB.transform(this.worldSpaceAABB, adtSpaceFromPlacementSpace);
    return [vertexBuffer, indexBuffer, adtChunks];
  }
}

export class DoodadData {
  public visible = true;
  public worldAABB = new AABB();

  constructor(public modelId: number, public modelMatrix: mat4, public color: number[] | null) {
  }

  public setVisible(visible: boolean) {
    this.visible = visible;
  }

  static fromAdtDoodad(doodad: WowDoodad): DoodadData {
    let position: vec3 = [doodad.position.x - MAP_SIZE, doodad.position.y, doodad.position.z - MAP_SIZE];
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

  static fromWmoDoodad(doodad: WowDoodadDef, modelIds: Uint32Array, wmoDefModelMatrix: mat4): DoodadData {
    let position: vec3 = [doodad.position.x, doodad.position.y, doodad.position.z];
    let rotation: quat = [doodad.orientation.x, doodad.orientation.y, doodad.orientation.z, doodad.orientation.w];
    let scale = doodad.scale;
    let color = [doodad.color.g, doodad.color.b, doodad.color.r, doodad.color.a]; // BRGA
    const modelId = modelIds[doodad.name_index];
    let doodadMat = mat4.create();
    setMatrixTranslation(doodadMat, position);
    const rotMat = mat4.fromQuat(mat4.create(), rotation as quat);
    mat4.mul(doodadMat, doodadMat, rotMat);
    mat4.scale(doodadMat, doodadMat, [scale, scale, scale]);
    mat4.mul(doodadMat, wmoDefModelMatrix, doodadMat);
    return new DoodadData(modelId, doodadMat, color);
  }

  public setBoundingBoxFromModel(model: ModelData) {
    this.worldAABB.transform(model.modelAABB, this.modelMatrix);
  }
}

export class LazyWorldData {
  public wdt: WowWdt;
  public adts: AdtData[] = [];
  private loadedAdtFileIds: number[] = [];
  public globalWmo: WmoData | null = null;
  public globalWmoDef: WmoDefinition | null = null;
  private adtFileIds: WowMapFileDataIDs[] = [];

  constructor(public fileId: number, public startAdtCoords: [number, number], public adtRadius = 2) {
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

    const wowAdt = rust.WowAdt.new(await fetchDataByFileID(fileIDs.root_adt, dataFetcher));
    wowAdt.append_obj_adt(await fetchDataByFileID(fileIDs.obj0_adt, dataFetcher));
    if (fileIDs.obj1_adt !== 0) {
      wowAdt.append_lod_obj_adt(await fetchDataByFileID(fileIDs.obj1_adt, dataFetcher));
    }
    wowAdt.append_tex_adt(await fetchDataByFileID(fileIDs.tex0_adt, dataFetcher));

    const adt = new AdtData(fileIDs.root_adt, wowAdt);
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
      const def = this.wdt.global_wmo!;
      this.globalWmo = await cache.loadWmo(def.name_id);
      this.globalWmoDef = WmoDefinition.fromGlobalDefinition(def, this.globalWmo);
    } else {
      const adtFileIDs = this.wdt.get_loaded_map_data();
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
        adt.setWorldFlags(this.wdt);

        this.adts.push(adt);
      }
    }
  }
}
