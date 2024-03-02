import * as Viewer from '../viewer.js';
import { SceneContext } from '../SceneBase.js';
import { rust } from '../rustlib.js';
import { WowM2, WowSkin, WowBlp, WowPixelFormat, WowWdt, WowAdt, WowAdtChunkDescriptor, WowDoodad, WowSkinSubmesh, WowModelBatch, WowAdtWmoDefinition } from '../../rust/pkg/index.js';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper.js';
import { DeviceProgram } from '../Program.js';
import { GfxDevice, GfxVertexAttributeDescriptor, GfxInputLayoutBufferDescriptor, GfxVertexBufferFrequency, GfxBufferUsage, GfxVertexBufferDescriptor, GfxBindingLayoutDescriptor, GfxCullMode, GfxIndexBufferDescriptor, makeTextureDescriptor2D, GfxMipFilterMode, GfxTexFilterMode, GfxWrapMode, GfxTextureDimension, GfxTextureUsage, GfxInputLayoutDescriptor, GfxClipSpaceNearZ } from '../gfx/platform/GfxPlatform.js';
import { GfxFormat } from '../gfx/platform/GfxPlatformFormat.js';
import { GfxBuffer, GfxInputLayout, GfxProgram } from '../gfx/platform/GfxPlatformImpl.js';
import { GfxRenderInst, GfxRenderInstList, GfxRenderInstManager } from '../gfx/render/GfxRenderInstManager.js';
import { makeStaticDataBuffer } from '../gfx/helpers/BufferHelpers.js';
import { makeBackbufferDescSimple, standardFullClearRenderPassDescriptor, pushAntialiasingPostProcessPass } from '../gfx/helpers/RenderGraphHelpers.js';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph.js';
import { fillMatrix4x4, fillVec4, fillVec4v } from '../gfx/helpers/UniformBufferHelpers.js';
import { DataFetcher, NamedArrayBufferSlice } from '../DataFetcher.js';
import { nArray } from '../util.js';
import { TextureCache } from './tex.js';
import { TextureMapping } from '../TextureHolder.js';
import { mat4, vec3, vec4 } from 'gl-matrix';
import { ModelData, SkinData, AdtData, WorldData, DoodadData, WmoData, WmoBatchData, WmoDefinition, LazyWorldData, WowCache, LightDatabase, WmoGroupData } from './data.js';
import { getMatrixTranslation, lerp, projectionMatrixForFrustum } from "../MathHelpers.js";
import { fetchFileByID, fetchDataByFileID, initFileList, getFilePath } from "./util.js";
import { CameraController, computeViewSpaceDepthFromWorldSpaceAABB } from '../Camera.js';
import { TextureListHolder, Panel } from '../ui.js';
import { GfxTopology, convertToTriangleIndexBuffer } from '../gfx/helpers/TopologyHelpers.js';
import { drawWorldSpaceAABB, drawWorldSpaceText, getDebugOverlayCanvas2D, interactiveVizSliderSelect } from '../DebugJunk.js';
import { Frustum, AABB } from '../Geometry.js';
import { ModelProgram, MAX_DOODAD_INSTANCES, WmoProgram, TerrainProgram, SkyboxProgram, BaseProgram } from './program.js';
import { ViewerRenderInput } from '../viewer.js';
import { skyboxIndices, skyboxVertices } from './skybox.js';
import { ModelRenderer, SkyboxRenderer, TerrainRenderer, WmoRenderer } from './render.js';

const id = 'WorldOfWarcaft';
const name = 'World of Warcraft';

const DEBUG_DRAW_ADT_BOUNDING_BOXES = false;
const DEBUG_DRAW_WMO_BOUNDING_BOXES = false;

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

export const adtSpaceFromPlacementSpace: mat4 = mat4.invert(mat4.create(), noclipSpaceFromAdtSpace);
mat4.mul(adtSpaceFromPlacementSpace, adtSpaceFromPlacementSpace, noclipSpaceFromPlacementSpace);

export const adtSpaceFromModelSpace: mat4 = mat4.invert(mat4.create(), noclipSpaceFromAdtSpace);
mat4.mul(adtSpaceFromModelSpace, adtSpaceFromModelSpace, noclipSpaceFromModelSpace);

export const placementSpaceFromModelSpace: mat4 = mat4.invert(mat4.create(), noclipSpaceFromPlacementSpace);
mat4.mul(placementSpaceFromModelSpace, placementSpaceFromModelSpace, noclipSpaceFromModelSpace);

export const modelSpaceFromAdtSpace: mat4 = mat4.invert(mat4.create(), adtSpaceFromModelSpace);

export class View {
    // aka viewMatrix
    public viewFromWorldMatrix = mat4.create();
    // aka worldMatrix
    public worldFromViewMatrix = mat4.create();
    public clipFromWorldMatrix = mat4.create();
    // aka projectionMatrix
    public clipFromViewMatrix = mat4.create();
    public interiorSunDirection: vec4 = [-0.30822, -0.30822, -0.89999998, 0];
    public exteriorDirectColorDirection: vec4 = [-0.30822, -0.30822, -0.89999998, 0];
    public clipSpaceNearZ: GfxClipSpaceNearZ;
    public cameraPos = vec3.create();
    public frustum: Frustum = new Frustum();
    public time: number;
    public deltaTime: number;
    public farPlane = 1000;
    public timeOffset = 1440;
    public secondsPerGameDay = 60;

    public finishSetup(): void {
      mat4.invert(this.worldFromViewMatrix, this.viewFromWorldMatrix);
      mat4.mul(this.clipFromWorldMatrix, this.clipFromViewMatrix, this.viewFromWorldMatrix);
      getMatrixTranslation(this.cameraPos, this.worldFromViewMatrix);
      this.frustum.updateClipFrustum(this.clipFromWorldMatrix, this.clipSpaceNearZ);
    }

    private calculateSunDirection(): void {
      const theta = 3.926991;
      const phiMin = 2.2165682;
      const phiMax = 1.9198623;
      let timePct = (this.time % 1440.0) / 1440.0;
      let phi;
      if (timePct < 0.5) {
        phi = lerp(phiMax, phiMin, timePct / 0.5);
      } else {
        phi = lerp(phiMin, phiMax, (timePct - 0.5) / 0.5);
      }
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);
      this.exteriorDirectColorDirection = [sinPhi * cosTheta, sinPhi * sinTheta, cosPhi, 0];
    }

    public cameraDistanceToWorldSpaceAABB(aabb: AABB): number {
      let center: vec3 = [0, 0, 0]
      aabb.centerPoint(center);
      return vec3.distance(this.cameraPos, center);
    }

    public setupFromViewerInput(viewerInput: Viewer.ViewerRenderInput): void {
      this.clipSpaceNearZ = viewerInput.camera.clipSpaceNearZ;
      mat4.mul(this.viewFromWorldMatrix, viewerInput.camera.viewMatrix, noclipSpaceFromAdtSpace);
      projectionMatrixForFrustum(this.clipFromViewMatrix,
        viewerInput.camera.left,
        viewerInput.camera.right,
        viewerInput.camera.bottom,
        viewerInput.camera.top,
        viewerInput.camera.near,
        this.farPlane
      );
      this.time = (viewerInput.time / this.secondsPerGameDay + this.timeOffset) % 2880;
      this.deltaTime = viewerInput.deltaTime;
      this.calculateSunDirection();
      this.finishSetup();
    }
}

enum CullingState {
  Running,
  Paused,
  OneShot,
}

export class MapArray<K, V> {
  public map: Map<K, V[]> = new Map();

  constructor() {
  }

  public has(key: K): boolean {
    return this.map.has(key);
  }

  public get(key: K): V[] {
    const result = this.map.get(key);
    if (result === undefined) {
      return [];
    }
    return result;
  }

  public append(key: K, value: V) {
    if (this.map.has(key)) {
      this.map.get(key)!.push(value);
    } else {
      this.map.set(key, [value]);
    }
  }

  public extend(key: K, values: V[]) {
    if (this.map.has(key)) {
      this.map.set(key, this.map.get(key)!.concat(values));
    } else {
      this.map.set(key, values);
    }
  }

  public keys(): IterableIterator<K> {
    return this.map.keys();
  }

  public values(): IterableIterator<V[]> {
    return this.map.values();
  }
}

export class WdtScene implements Viewer.SceneGfx {
  private terrainRenderers: Map<number, TerrainRenderer> = new Map();
  private modelRenderers: Map<number, ModelRenderer> = new Map();
  private wmoRenderers: Map<number, WmoRenderer> = new Map();
  private skyboxRenderer: SkyboxRenderer;
  private renderInstListMain = new GfxRenderInstList();

  public MAX_EXTERIOR_WMO_RENDER_DIST = 1000;
  public MAX_INTERIOR_WMO_RENDER_DIST = 500;
  public ADT_LOD0_DISTANCE = 1000;

  private terrainProgram: GfxProgram;
  private modelProgram: GfxProgram;
  private wmoProgram: GfxProgram;
  private skyboxProgram: GfxProgram;

  private modelIdToDoodads: MapArray<number, DoodadData> = new MapArray();
  private wmoIdToDefs: MapArray<number, WmoDefinition> = new MapArray();

  public mainView = new View();
  private textureCache: TextureCache;
  public enableProgressiveLoading = false;
  public cullingState = CullingState.Running;
  public currentAdtCoords: [number, number] = [0, 0];

  // FIXME
  public forceLod = 0;

  constructor(private device: GfxDevice, public world: WorldData | LazyWorldData, public renderHelper: GfxRenderHelper, private lightDb: LightDatabase) {
    console.time('WdtScene construction');
    this.textureCache = new TextureCache(this.renderHelper.renderCache);
    this.terrainProgram = this.renderHelper.renderCache.createProgram(new TerrainProgram());
    this.modelProgram = this.renderHelper.renderCache.createProgram(new ModelProgram());
    this.wmoProgram = this.renderHelper.renderCache.createProgram(new WmoProgram());
    this.skyboxProgram = this.renderHelper.renderCache.createProgram(new SkyboxProgram());

    if (this.world.globalWmo) {
      this.setupWmoDef(this.world.globalWmoDef!);
      this.setupWmo(this.world.globalWmo);
    } else {
      for (let adt of this.world.adts) {
        this.setupAdt(adt);
      }
    }

    this.skyboxRenderer = new SkyboxRenderer(device, this.renderHelper);
    console.timeEnd('WdtScene construction');
  }

  public setupWmoDef(def: WmoDefinition) {
    this.wmoIdToDefs.append(def.wmoId, def);
    for (let doodad of def.doodads) {
      this.modelIdToDoodads.append(doodad.modelId, doodad);
    }
  }

  public setupAdt(adt: AdtData) {
    if (this.terrainRenderers.has(adt.fileId)) {
      return;
    }

    this.terrainRenderers.set(adt.fileId, new TerrainRenderer(
      this.device,
      this.renderHelper,
      adt,
      this.textureCache,
    ));
    for (let lodData of adt.lodData) {
      for (let modelId of lodData.modelIds) {
        const model = adt.models.get(modelId)!;
        this.createModelRenderer(model);
      }
      for (let wmoDef of lodData.wmoDefs) {
        this.setupWmo(adt.wmos.get(wmoDef.wmoId)!);
        this.setupWmoDef(wmoDef);
      }
      for (let doodad of lodData.doodads) {
        this.modelIdToDoodads.append(doodad.modelId, doodad);
      }
    }
  }

  public setupWmo(wmo: WmoData) {
    if (this.wmoRenderers.has(wmo.fileId)) {
      return;
    }

    this.wmoRenderers.set(wmo.fileId, new WmoRenderer(this.device,
      wmo,
      this.textureCache,
      this.renderHelper,
    ));
    for (let model of wmo.models.values()) {
      this.createModelRenderer(model);
    }
  }

  // TODO
  public teardownWmo(wmo: WmoData) {

  }

  // TODO
  public teardownAdt(adt: AdtData) {

  }

  public createModelRenderer(model: ModelData) {
    if (!this.modelRenderers.has(model.fileId)) {
      this.modelRenderers.set(model.fileId, new ModelRenderer(this.device, model, this.renderHelper, this.textureCache));
    }
  }

  private shouldCull(): boolean {
    return this.cullingState !== CullingState.Paused;
  }

  private updateCullingState() {
    if (this.cullingState === CullingState.OneShot) {
      this.cullingState = CullingState.Paused;
    }
  }

  public resumeCulling() {
    this.cullingState = CullingState.Running;
  }

  public pauseCulling() {
    this.cullingState = CullingState.Paused;
  }

  public cullOneShot() {
    this.cullingState = CullingState.OneShot;
  }

  public cull() {
    if (this.world.globalWmo) {

    } else {
      for (let adt of this.world.adts) {
        this.cullAdt(adt);
      }
    }
  }

  public cullWmoDef(def: WmoDefinition, wmo: WmoData) {
    if (DEBUG_DRAW_WMO_BOUNDING_BOXES) {
      drawWorldSpaceAABB(getDebugOverlayCanvas2D(), this.mainView.clipFromWorldMatrix, def.worldSpaceAABB);
      for (let groupAABB of def.groupDefAABBs.values()) {
        drawWorldSpaceAABB(getDebugOverlayCanvas2D(), this.mainView.clipFromWorldMatrix, groupAABB);
      }
    }
    def.setVisible(this.mainView.frustum.contains(def.worldSpaceAABB));
    if (!def.visible) {
      return;
    }
    // TODO: portal culling
    for (let [groupId, groupAABB] of def.groupDefAABBs.entries()) {
      if (this.mainView.frustum.contains(groupAABB)) {
        const group = wmo.groups.find(group => group.fileId === groupId)!;
        const distance = this.mainView.cameraDistanceToWorldSpaceAABB(groupAABB);
        if (group.flags.exterior) {
          def.setGroupVisible(groupId, distance < this.MAX_EXTERIOR_WMO_RENDER_DIST);
        } else {
          def.setGroupVisible(groupId, distance < this.MAX_INTERIOR_WMO_RENDER_DIST);
        }
      } else {
        def.setGroupVisible(groupId, false);
      }
    }
  }

  public cullAdt(adt: AdtData) {
    if (DEBUG_DRAW_ADT_BOUNDING_BOXES) {
      drawWorldSpaceAABB(getDebugOverlayCanvas2D(), this.mainView.clipFromWorldMatrix, adt.worldSpaceAABB);
    }
    if (this.mainView.frustum.contains(adt.worldSpaceAABB)) {
      adt.setVisible(true);
      for (let chunk of adt.chunkData) {
        chunk.setVisible(this.mainView.frustum.contains(chunk.worldSpaceAABB));
      }
      const distance = this.mainView.cameraDistanceToWorldSpaceAABB(adt.worldSpaceAABB);
      adt.setLodLevel(distance < this.ADT_LOD0_DISTANCE ? 0 : 1);
    } else {
      adt.setVisible(false);
    }
    for (let def of adt.lodWmoDefs()) {
      const wmo = adt.wmos.get(def.wmoId)!;
      this.cullWmoDef(def, wmo);
    }
  }

  private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
    this.mainView.setupFromViewerInput(viewerInput);

    const template = this.renderHelper.pushTemplateRenderInst();
    template.setMegaStateFlags({ cullMode: GfxCullMode.Back });
    template.setGfxProgram(this.skyboxProgram);
    template.setBindingLayouts(SkyboxProgram.bindingLayouts);

    BaseProgram.layoutUniformBufs(
      template,
      viewerInput.camera.projectionMatrix,
      this.mainView,
      this.lightDb.getGlobalLightingData(this.mainView.cameraPos, this.mainView.time)
    );
    this.renderHelper.renderInstManager.setCurrentRenderInstList(this.renderInstListMain);
    this.skyboxRenderer.prepareToRenderSkybox(this.renderHelper.renderInstManager)

    if (this.shouldCull()) {
      this.cull();
    }

    template.setGfxProgram(this.terrainProgram);
    template.setBindingLayouts(TerrainProgram.bindingLayouts);
    for (let renderer of this.terrainRenderers.values()) {
      renderer.prepareToRenderTerrain(this.renderHelper.renderInstManager);
    }

    template.setGfxProgram(this.wmoProgram);
    template.setBindingLayouts(WmoProgram.bindingLayouts);
    for (let [wmoId, renderer] of this.wmoRenderers.entries()) {
      const defs = this.wmoIdToDefs.get(wmoId)!;
      renderer.prepareToRenderWmo(this.renderHelper.renderInstManager, defs);
    }

    template.setBindingLayouts(ModelProgram.bindingLayouts);
    template.setGfxProgram(this.modelProgram);
    for (let [modelId, renderer] of this.modelRenderers.entries()) {
      const doodads = this.modelIdToDoodads.get(modelId)!;
      const visibleDoodads = doodads.filter(doodad => doodad.visible);
      if (visibleDoodads.length === 0) continue;
      renderer.update(this.mainView);
      renderer.prepareToRenderModel(this.renderHelper.renderInstManager, visibleDoodads);
    }

    this.renderHelper.renderInstManager.popTemplateRenderInst();
    this.renderHelper.prepareToRender();
    this.updateCullingState();
  }

  private updateCurrentAdt() {
    const [worldY, worldX, _] = this.mainView.cameraPos;
    const adtCoords = this.adtCoordsForWorldCoords(worldX, worldY);
    if (adtCoords) {
      if (this.currentAdtCoords[0] !== adtCoords[0] || this.currentAdtCoords[1] !== adtCoords[1]) {
        this.currentAdtCoords = adtCoords;
        if (this.enableProgressiveLoading && 'onEnterAdt' in this.world) {
          this.world.onEnterAdt(this.currentAdtCoords, this);
        }
      }
    }
  }

  public adtCoordsForWorldCoords(x: number, y: number): [number, number] | undefined {
    const adt_dimension = 533.33;
    const x_coord = Math.floor(32 - x / adt_dimension);
    const y_coord = Math.floor(32 - y / adt_dimension);
    if (x_coord >= 0 && x_coord < 64 && y_coord >= 0 && y_coord < 64) {
      return [x_coord, y_coord];
    }
    return undefined;
  }

  public adjustCameraController(c: CameraController) {
      c.setSceneMoveSpeedMult(0.51);
  }

  render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
    viewerInput.camera.setClipPlanes(0.1);
    this.updateCurrentAdt();
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
        this.renderInstListMain.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
      });
    });
    pushAntialiasingPostProcessPass(builder, this.renderHelper, viewerInput, mainColorTargetID);
    builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

    this.prepareToRender(device, viewerInput);
    this.renderHelper.renderGraph.execute(builder);
    this.renderInstListMain.reset();
    renderInstManager.resetRenderInsts();
  }

  destroy(device: GfxDevice): void {
    for (let renderer of this.terrainRenderers.values()) {
      renderer.destroy(device);
    };
    for (let renderer of this.modelRenderers.values()) {
      renderer.destroy(device);
    }
    for (let renderer of this.wmoRenderers.values()) {
      renderer.destroy(device);
    }
    this.skyboxRenderer.destroy(device);
    this.textureCache.destroy(device);
    this.renderHelper.destroy();
  }
}

class WdtSceneDesc implements Viewer.SceneDesc {
  public id: string;

  constructor(public name: string, public fileId: number, public lightdbMapId: number) {
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
    const lightDb = new LightDatabase(this.lightdbMapId);
    await lightDb.load(dataFetcher);
    return new WdtScene(device, wdt, renderHelper, lightDb);
  }
}

class ContinentSceneDesc implements Viewer.SceneDesc {
  public id: string;

  constructor(public name: string, public fileId: number, public startX: number, public startY: number, public lightdbMapId: number) {
    this.id = `${name}-${fileId}`;
  }

  public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
    const dataFetcher = context.dataFetcher;
    const cache = new WowCache(dataFetcher);
    const renderHelper = new GfxRenderHelper(device);
    await initFileList(dataFetcher);
    rust.init_panic_hook();
    const wdt = new LazyWorldData(this.fileId, [this.startX, this.startY], 1, dataFetcher, cache);
    console.time('loading wdt')
    await wdt.load();
    console.timeEnd('loading wdt')
    const lightDb = new LightDatabase(this.lightdbMapId);
    await lightDb.load(dataFetcher);
    return new WdtScene(device, wdt, renderHelper, lightDb);
  }
}

const sceneDescs = [
    "Classic Instances",
    new WdtSceneDesc('Zul-Farak', 791169, 209),
    new WdtSceneDesc('Blackrock Depths', 780172, 230),
    new WdtSceneDesc('Scholomance', 790713, 289),
    new WdtSceneDesc("Naxxramas", 827115, 533),
    new WdtSceneDesc("Caverns of Time", 829736, 269),
    new WdtSceneDesc("Ruins of Ahn'qiraj", 775637, 509),
    new WdtSceneDesc("Deeprun Tram", 780788, 369),
    new WdtSceneDesc("Deadmines", 780605, 36),
    new WdtSceneDesc("Shadowfang Keep", 790796, 33),
    new WdtSceneDesc("Blackrock Spire", 780175, 229),
    new WdtSceneDesc("Stratholme", 791063, 329),
    new WdtSceneDesc('Mauradon', 788656, 349),
    new WdtSceneDesc('Wailing Caverns', 791429, 43),
    new WdtSceneDesc('Razorfen Kraul', 790640, 47),
    new WdtSceneDesc('Razorfen Downs', 790517, 129),
    new WdtSceneDesc('Blackfathom Deeps', 780169, 48),
    new WdtSceneDesc('Uldaman', 791372, 70),
    new WdtSceneDesc('Gnomeragon', 782773, 90),
    new WdtSceneDesc('Sunken Temple', 791166, 109),
    new WdtSceneDesc('Scarlet Monastery - Graveyard', 788662, 189),
    new WdtSceneDesc('Scarlet Monastery - Cathedral', 788662, 189),
    new WdtSceneDesc('Scarlet Monastery - Library', 788662, 189),
    new WdtSceneDesc('Scarlet Monastery - Armory', 865519, 189),
    new WdtSceneDesc("Onyxia's Lair", 789922, 249),
    new WdtSceneDesc("Zul'gurub", 791432, 309),
    new WdtSceneDesc("Ragefire Chasm", 789981, 389),
    new WdtSceneDesc("Dire Maul", 780814, 429),
    new WdtSceneDesc("Molten Core", 788659, 409),
    new WdtSceneDesc("Blackwing Lair", 780178, 469),
    new WdtSceneDesc("Ahn'Qiraj Temple", 775840, 531),

    "Burning Crusade Instances",
    new WdtSceneDesc("Hellfire Citadel: The Shattered Halls", 831277, 540),
    new WdtSceneDesc("Hellfire Citadel: The Blood Furnace", 830642, 542),
    new WdtSceneDesc("Hellfire Citadel: Ramparts", 832154, 543),
    new WdtSceneDesc("Magtheridon's Lair", 833183, 544),
    new WdtSceneDesc("Coilfang: The Steamvault", 828422, 545),
    new WdtSceneDesc("Coilfang: The Underbog", 831262, 546),
    new WdtSceneDesc("Coilfang: The Slave Pens", 830731, 547),
    new WdtSceneDesc("Coilfang: Serpentshrine Cavern", 829900, 548),
    new WdtSceneDesc("Karazahn", 834192, 532),
    new WdtSceneDesc("Caverns of Time: Hyjal", 831824, 534),
    new WdtSceneDesc("Caverns of Time: The Escape from Durnholde", 833998, 560),
    new WdtSceneDesc("Tempest Keep (Raid)", 832484, 550),
    new WdtSceneDesc("Tempest Keep: The Arcatraz", 832070, 552),
    new WdtSceneDesc("Tempest Keep: The Botanica", 833950, 553),
    new WdtSceneDesc("Tempest Keep: The Mechanar", 831974, 554),
    new WdtSceneDesc("Auchindoun: Shadow Labyrinth", 828331, 555),
    new WdtSceneDesc("Auchindoun: Sethekk Halls", 828811, 556),
    new WdtSceneDesc("Auchindoun: Mana-Tombs", 830899, 557),
    new WdtSceneDesc("Auchindoun: Auchenai Crypts", 830415, 558),
    new WdtSceneDesc("Gruul's Lair", 833180, 565),
    new WdtSceneDesc("Zul'Aman", 815727, 568),
    new WdtSceneDesc("Black Temple", 829630, 565),
    new WdtSceneDesc("The Sunwell: Magister's Terrace", 834223, 585),
    new WdtSceneDesc("The Sunwell: Plateau", 832953, 580),

    "PvP",
    new WdtSceneDesc('Alterac Valley', 790112, 30), // AKA pvpzone01
    new WdtSceneDesc('Warsong Gulch', 790291, 489), // AKA pvpzone03
    new WdtSceneDesc('Arathi Basin', 790377, 529), // AKA pvpzone04
    new WdtSceneDesc('Eye of the Storm', 788893, 566),
    new WdtSceneDesc('Arena: Nagrand', 790469, 559),
    new WdtSceneDesc("Arena: Blade's Edge", 780261, 562),

    "Unreleased",
    new WdtSceneDesc('Emerald Dream (classic)', 780817, 0),
    new WdtSceneDesc('Developer Island', 857684, 0),
    new WdtSceneDesc('Test 01', 2323096, 0),
    new WdtSceneDesc('Scott Test', 863335, 0),
    new WdtSceneDesc('Collin Test', 863984, 0),
    new WdtSceneDesc('PvP Zone 02', 861092, 0),

    "Kalimdor",
    new ContinentSceneDesc("??", 782779, 35, 23, 1),
    new ContinentSceneDesc("GM Island", 782779, 1, 1, 1),
    
    "Eastern Kingdoms",
    new ContinentSceneDesc("Undercity", 775971, 31, 28, 0),
    new ContinentSceneDesc("Stormwind", 775971, 31, 48, 0),
    new ContinentSceneDesc("Ironforge", 775971, 33, 40, 0),
    new ContinentSceneDesc("Dun Morogh", 775971, 31, 43, 0),
    new ContinentSceneDesc("Redridge", 775971, 35, 50, 0),
    new ContinentSceneDesc("Blockrock Mountain", 775971, 34, 45, 0),
    new ContinentSceneDesc("Booty Bay", 775971, 31, 58, 0),

    "Outland",
    new ContinentSceneDesc("The Dark Portal", 828395, 29, 32, 530),

    "Northrend",
    new ContinentSceneDesc("???", 822688, 31, 28, 571),
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs, hidden: false };