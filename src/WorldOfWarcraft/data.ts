import { vec3, mat4, vec4, quat } from "gl-matrix";
import { WowM2, WowSkin, WowBlp, WowSkinSubmesh, WowModelBatch, WowAdt, WowAdtChunkDescriptor, WowDoodad, WowWdt, WowWmo, WowWmoGroup, WowWmoMaterialInfo, WowWmoMaterialBatch, WowQuat, WowVec3, WowDoodadDef, WowWmoMaterial, WowAdtWmoDefinition, WowGlobalWmoDefinition, WowM2Material, WowM2MaterialFlags, WowM2BlendingMode, WowM2AnimationManager, WowVec4 } from "../../rust/pkg";
import { DataFetcher } from "../DataFetcher.js";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers.js";
import { GfxDevice, GfxVertexBufferDescriptor, GfxIndexBufferDescriptor, GfxBufferUsage, GfxBlendMode, GfxCullMode, GfxBlendFactor, GfxChannelWriteMask, GfxCompareMode } from "../gfx/platform/GfxPlatform.js";
import { rust } from "../rustlib.js";
import { fetchFileByID, fetchDataByFileID } from "./util.js";
import { MathConstants, setMatrixTranslation } from "../MathHelpers.js";
import { adtSpaceFromModelSpace, adtSpaceFromPlacementSpace, placementSpaceFromModelSpace, noclipSpaceFromPlacementSpace, noclipSpaceFromModelSpace, noclipSpaceFromAdtSpace } from "./scenes.js";
import { AABB } from "../Geometry.js";
import { GfxRenderInst, GfxRendererLayer, makeSortKey, setSortKeyDepth } from "../gfx/render/GfxRenderInstManager.js";
import { ModelProgram } from "./program.js";
import { fillMatrix4x4, fillVec4, fillVec4v } from "../gfx/helpers/UniformBufferHelpers.js";
import { AttachmentStateSimple, setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers.js";
import { reverseDepthForCompareMode } from "../gfx/helpers/ReversedDepthHelpers.js";
import { computeViewSpaceDepthFromWorldSpaceAABB } from "../Camera";


export class ModelData {
  public m2: WowM2;
  public skins: WowSkin[] = [];
  public blps: WowBlp[] = [];
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

  public async load(dataFetcher: DataFetcher): Promise<undefined> {
    this.m2 = await fetchFileByID(this.fileId, dataFetcher, rust.WowM2.new);
    this.textureLookupTable = this.m2.get_texture_lookup_table();
    this.textureTransformsLookupTable = this.m2.get_texture_transforms_lookup_table();
    this.transparencyLookupTable = this.m2.get_transparency_lookup_table();
    this.animationManager = this.m2.get_animation_manager();
    for (let txid of this.m2.texture_ids) {
      if (txid === 0) continue;
      this.blpIds.push(txid);
      this.blps.push(await fetchFileByID(txid, dataFetcher, rust.WowBlp.new));
    }

    this.materials = this.m2.get_materials().map(mat => {
      return [mat.blending_mode, rust.WowM2MaterialFlags.new(mat.flags)];
    })

    for (let skid of this.m2.skin_ids) {
      this.skins.push(await fetchFileByID(skid, dataFetcher, rust.WowSkin.new));
    }

    this.updateAnimation(0, 0);
  }

  public updateAnimation(delaTime: number, globalDeltaTime: number) {
    this.animationManager.update(delaTime, globalDeltaTime);
    this.vertexColors = this.animationManager.calculated_colors!;
    this.textureWeights = this.animationManager.calculated_transparencies!;

    const rotations = this.animationManager.calculated_texture_rotations!;
    const translations = this.animationManager.calculated_texture_translations!;
    const scalings = this.animationManager.calculated_texture_scalings!;
    const transforms: mat4[] = [];
    for (let i = 0; i < rotations.length; i++) {
      const transform = mat4.create();
      mat4.fromQuat(transform, [rotations[i].x, rotations[i].y, rotations[i].z, rotations[i].w]);
      mat4.translate(transform, transform, [translations[i].x, translations[i].y, translations[i].z]);
      mat4.scale(transform, transform, [scalings[i].x, scalings[i].y, scalings[i].z]);
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
  public tex0: [number, WowBlp];
  public tex1: [number, WowBlp] | null;
  public tex2: [number, WowBlp] | null;
  public tex3: [number, WowBlp] | null;
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

  private getBlpId(n: number): [number, WowBlp] | null {
    if (n < this.batch.texture_count) {
      const i = this.model.textureLookupTable[this.batch.texture_combo_index + n];
      return [this.model.blpIds[i], this.model.blps[i]];
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
  private getCurrentTextureTransforms(): [mat4, mat4] {
    return [mat4.identity(mat4.create()), mat4.identity(mat4.create())];
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
    const [t0, t1] = this.getCurrentTextureTransforms();
    offset += fillMatrix4x4(uniformBuf, offset, t0);
    offset += fillMatrix4x4(uniformBuf, offset, t1);
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
  public blps: Map<number, WowBlp>;
  public models: Map<number, ModelData>;
  public wmos: Map<number, WmoData>;
  public wmoDefs: WmoDefinition[] = [];
  public hasBigAlpha: boolean;
  public hasHeightTexturing: boolean;

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

export class WorldData {
  public wdt: WowWdt;
  public adts: AdtData[] = [];
  public globalWmo: WmoData | null = null;
  public globalWmoDef: WmoDefinition | null = null;

  constructor(public fileId: number) {
  }

  public async load(dataFetcher: DataFetcher) {
    this.wdt = await fetchFileByID(this.fileId, dataFetcher, rust.WowWdt.new);
    if (this.wdt.wdt_uses_global_map_obj()) {
      const globalWmo = this.wdt.global_wmo!;
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
        adt.setWorldFlags(this.wdt);

        this.adts.push(adt);
      }
    }
  }
}
