import { vec3, mat4, vec4 } from "gl-matrix";
import { WowM2, WowSkin, WowBlp, WowSkinSubmesh, WowBatch, WowAdt, WowAdtChunkDescriptor, WowDoodad, WowWdt, WowWmo, WowWmoGroup, WowWmoMaterialInfo, WowWmoMaterialBatch, WowQuat, WowVec3, WowDoodadDef } from "../../rust/pkg";
import { DataFetcher } from "../DataFetcher.js";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers.js";
import { GfxDevice, GfxVertexBufferDescriptor, GfxIndexBufferDescriptor, GfxBufferUsage } from "../gfx/platform/GfxPlatform.js";
import { rust } from "../rustlib.js";
import { fetchFileByID, fetchDataByFileID } from "./scenes.js";


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
      this.blpIds.push(txid);
      this.blps.push(await fetchFileByID(txid, dataFetcher, rust.WowBlp.new));
    }

    for (let skid of this.m2.skin_ids) {
      this.skins.push(await fetchFileByID(skid, dataFetcher, rust.WowSkin.new));
    }
  }
}

export class WmoGroupData {
    public group: WowWmoGroup;

    constructor(public fileId: number) {
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

    constructor(public fileId: number) {
        this.blps = new Map();
        this.models = new Map();
    }

    public async load(dataFetcher: DataFetcher): Promise<undefined> {
        this.wmo = await fetchFileByID(this.fileId, dataFetcher, rust.WowWmo.new);

        for (let tex of this.wmo.textures) {
            for (let texId of [tex.texture_1, tex.texture_2, tex.texture_3]) {
                if (texId !== 0 && !this.blps.has(texId)) {
                    let blp = await fetchFileByID(texId, dataFetcher, rust.WowBlp.new);
                    this.blps.set(texId, blp);
                }
            }
        }

        for (let modelId of this.wmo.doodad_file_ids) {
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

export class AdtData {
  public blps: Map<number, WowBlp>;
  public models: Map<number, ModelData>;
  public wmos: Map<number, WmoData>;

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
        const wmoData = new WmoData(wmoDef.name_id);
        await wmoData.load(dataFetcher);
        this.wmos.set(wmoDef.name_id, wmoData);
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
  public modelMatrix: mat4;

  constructor(public position: vec3, public rotation: vec3 | vec4, public scale: number) {
    this.modelMatrix = this.getDoodadTranformMat();
  }

  static fromAdtDoodad(doodad: WowDoodad): DoodadData {
    let position: vec3 = [doodad.position.x - 17066, doodad.position.y, doodad.position.z - 17066];
    let rotation: vec3 = [doodad.rotation.x, doodad.rotation.y, doodad.rotation.z];
    let scale = doodad.scale / 1024;
    return new DoodadData(position, rotation, scale);
  }

  static fromWmoDoodad(doodad: WowDoodadDef): DoodadData {
    let position: vec3 = [doodad.position.x, doodad.position.y, doodad.position.z];
    let rotation: vec4 = [doodad.orientation.x, doodad.orientation.y, doodad.orientation.z, doodad.orientation.w];
    let scale = doodad.scale / 1024;
    return new DoodadData(position, rotation, scale);
  }

  private getDoodadTranformMat(): mat4 {
    const rotation = mat4.create();
    mat4.identity(rotation);
    mat4.rotateX(rotation, rotation, this.rotation[0]);
    mat4.rotateY(rotation, rotation, this.rotation[1]);
    mat4.rotateZ(rotation, rotation, this.rotation[2]);
    const doodadMat = mat4.create();
    mat4.fromRotationTranslationScale(
      doodadMat,
      rotation,
      this.position,
      [this.scale, this.scale, this.scale]
    );
    return doodadMat;
  }
}

export class WorldData {
  public wdt: WowWdt;
  public adts: AdtData[] = [];

  constructor(public fileId: number) {
  }

  public async load(dataFetcher: DataFetcher) {
    this.wdt = await fetchFileByID(this.fileId, dataFetcher, rust.WowWdt.new);
    for (let fileIDs of this.wdt.get_loaded_map_data()) {
      if (fileIDs.root_adt === 0) {
        console.log('null ADTs?')
        continue;
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
