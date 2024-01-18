import { vec3, mat4, vec4, quat } from "gl-matrix";
import { WowM2, WowSkin, WowBlp, WowSkinSubmesh, WowBatch, WowAdt, WowAdtChunkDescriptor, WowDoodad, WowWdt, WowWmo, WowWmoGroup, WowWmoMaterialInfo, WowWmoMaterialBatch, WowQuat, WowVec3, WowDoodadDef, WowWmoMaterial, WowAdtWmoDefinition, WowGlobalWmoDefinition } from "../../rust/pkg";
import { DataFetcher } from "../DataFetcher.js";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers.js";
import { GfxDevice, GfxVertexBufferDescriptor, GfxIndexBufferDescriptor, GfxBufferUsage } from "../gfx/platform/GfxPlatform.js";
import { rust } from "../rustlib.js";
import { fetchFileByID, fetchDataByFileID } from "./util.js";
import { MathConstants, setMatrixTranslation } from "../MathHelpers.js";
import { adtSpaceFromModelSpace, adtSpaceFromPlacementSpace, placementSpaceFromModelSpace } from "./scenes.js";


export class ModelData {
  public m2: WowM2;
  public skins: WowSkin[] = [];
  public blps: WowBlp[] = [];
  public blpIds: number[] = [];
  public textureLookupTable: Uint16Array;

  constructor(public fileId: number) {
  }

  public async load(dataFetcher: DataFetcher): Promise<undefined> {
    this.m2 = await fetchFileByID(this.fileId, dataFetcher, rust.WowM2.new);
    this.textureLookupTable = this.m2.get_texture_lookup_table();
    for (let txid of this.m2.texture_ids) {
      if (txid === 0) continue;
      this.blpIds.push(txid);
      this.blps.push(await fetchFileByID(txid, dataFetcher, rust.WowBlp.new));
    }

    for (let skid of this.m2.skin_ids) {
      this.skins.push(await fetchFileByID(skid, dataFetcher, rust.WowSkin.new));
    }
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

  public async load(dataFetcher: DataFetcher): Promise<undefined> {
    this.group = await fetchFileByID(this.fileId, dataFetcher, rust.WowWmoGroup.new);
  }
}

export class WmoData {
  public wmo: WowWmo;
  public groups: WmoGroupData[] = [];
  public blps: Map<number, WowBlp>;
  public models: Map<number, ModelData>;
  public materials: WowWmoMaterial[] = [];
  public modelIds: Uint32Array;

  constructor(public fileId: number) {
    this.blps = new Map();
    this.models = new Map();
  }

  public async load(dataFetcher: DataFetcher): Promise<undefined> {
    this.wmo = await fetchFileByID(this.fileId, dataFetcher, rust.WowWmo.new);

    for (let tex of this.wmo.textures) {
      this.materials.push(tex);
      for (let texId of [tex.texture_1, tex.texture_2, tex.texture_3]) {
        if (texId !== 0 && !this.blps.has(texId)) {
          let blp = await fetchFileByID(texId, dataFetcher, rust.WowBlp.new);
          this.blps.set(texId, blp);
        }
      }
    }

    this.modelIds = this.wmo.doodad_file_ids;
    for (let modelId of this.modelIds) {
      if (modelId !== 0 && !this.models.has(modelId)) {
        const modelData = new ModelData(modelId);
        await modelData.load(dataFetcher);
        this.models.set(modelId, modelData);
      }
    }

    for (let gfid of this.wmo.group_file_ids) {
      const group = new WmoGroupData(gfid);
      await group.load(dataFetcher);
      this.groups.push(group);
    }
  }
}

export class SkinData {
  public submeshes: WowSkinSubmesh[];
  public batches: WowBatch[];
  public indexBuffer: Uint16Array;

  constructor(public skin: WowSkin) {
    this.submeshes = skin.submeshes;
    this.batches = skin.batches;
    this.indexBuffer = skin.get_indices();
  }
}

export class WmoDefinition {
  public modelMatrix: mat4;

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
    return new WmoDefinition(def.name_id, def.doodad_set, scale, position, rotation);
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
    return new WmoDefinition(def.name_id, def.doodad_set, scale, position, rotation);
  }

  constructor(public wmoId: number, public doodadSet: number, scale: number, position: vec3, rotation: vec3) {
    this.modelMatrix = mat4.create();
    setMatrixTranslation(this.modelMatrix, position);
    mat4.scale(this.modelMatrix, this.modelMatrix, [scale, scale, scale]);
    mat4.rotateZ(this.modelMatrix, this.modelMatrix, MathConstants.DEG_TO_RAD * rotation[2]);
    mat4.rotateY(this.modelMatrix, this.modelMatrix, MathConstants.DEG_TO_RAD * rotation[1]);
    mat4.rotateX(this.modelMatrix, this.modelMatrix, MathConstants.DEG_TO_RAD * rotation[0]);
    mat4.mul(this.modelMatrix, this.modelMatrix, placementSpaceFromModelSpace);
    mat4.mul(this.modelMatrix, adtSpaceFromPlacementSpace, this.modelMatrix);
  }
}

export class AdtData {
  public blps: Map<number, WowBlp>;
  public models: Map<number, ModelData>;
  public wmos: Map<number, WmoData>;
  public wmoDefs: WmoDefinition[] = [];

  constructor(public innerAdt: WowAdt) {
    this.blps = new Map();
    this.models = new Map();
    this.wmos = new Map();
  }
  
  public async load(dataFetcher: DataFetcher) {
      const blpIds = this.innerAdt.get_texture_file_ids();
      for (let blpId of blpIds) {
        const blp = await fetchFileByID(blpId, dataFetcher, rust.WowBlp.new);
        this.blps.set(blpId, blp);
      }

      const modelIds = this.innerAdt.get_model_file_ids();
      for (let modelId of modelIds) {
        const model = new ModelData(modelId);
        await model.load(dataFetcher);
        this.models.set(modelId, model);
      }

      const mapObjectDefs = this.innerAdt.map_object_defs;
      for (let wmoDef of mapObjectDefs) {
        this.wmoDefs.push(WmoDefinition.fromAdtDefinition(wmoDef));
        if (!this.wmos.has(wmoDef.name_id)) {
          const wmoData = new WmoData(wmoDef.name_id);
          await wmoData.load(dataFetcher);
          this.wmos.set(wmoDef.name_id, wmoData);
        }
      }
  }

  public getBufsAndChunks(device: GfxDevice): [GfxVertexBufferDescriptor, GfxIndexBufferDescriptor, WowAdtChunkDescriptor[]] {
    const renderResult = this.innerAdt.get_render_result();
    const vertexBuffer = {
      buffer: makeStaticDataBuffer(device, GfxBufferUsage.Vertex, renderResult.vertex_buffer.buffer),
      byteOffset: 0,
    };
    const indexBuffer = {
      buffer: makeStaticDataBuffer(device, GfxBufferUsage.Index, renderResult.index_buffer.buffer),
      byteOffset: 0,
    };
    const adtChunks = renderResult.chunks;
    return [vertexBuffer, indexBuffer, adtChunks];
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
    const rotMat = mat4.fromQuat(mat4.create(), rotation.map((deg) => MathConstants.DEG_TO_RAD * deg) as quat);
    mat4.mul(doodadMat, doodadMat, rotMat);
    mat4.scale(doodadMat, doodadMat, [scale, scale, scale]);
    return new DoodadData(modelId, doodadMat, color);
  }
}

export class WorldData {
  public wdt: WowWdt;
  public adts: AdtData[] = [];
  public globalWmo: WmoData | null = null;
  public globalWmoDef: WmoDefinition | null = null;

  constructor(public fileId: number) {
  }

  public async load(dataFetcher: DataFetcher) {
    this.wdt = await fetchFileByID(this.fileId, dataFetcher, rust.WowWdt.new);
    const globalWmo = this.wdt.global_wmo;
    if (globalWmo) {
      this.globalWmo = new WmoData(globalWmo.name_id);
      await this.globalWmo.load(dataFetcher);
      this.globalWmoDef = WmoDefinition.fromGlobalDefinition(globalWmo);
    } else {
      for (let fileIDs of this.wdt.get_loaded_map_data()) {
        if (fileIDs.root_adt === 0) {
          throw new Error(`null ADTs in a non-global-WMO WDT`);
        }
        // TODO handle obj1 (LOD) adts
        const wowAdt = rust.WowAdt.new(await fetchDataByFileID(fileIDs.root_adt, dataFetcher));
        wowAdt.append_obj_adt(await fetchDataByFileID(fileIDs.obj0_adt, dataFetcher));
        wowAdt.append_tex_adt(await fetchDataByFileID(fileIDs.tex0_adt, dataFetcher));

        const adt = new AdtData(wowAdt);
        await adt.load(dataFetcher);

        this.adts.push(adt);
      }
    }
  }
}
