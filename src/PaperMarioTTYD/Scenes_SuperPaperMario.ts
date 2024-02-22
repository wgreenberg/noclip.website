
import * as Viewer from '../viewer.js';

import * as CX from '../Common/Compression/CX.js';
import * as U8 from '../rres/u8.js';

import * as TPL from './tpl.js';
import * as World from './world.js';
import { WorldRenderer, TPLTextureHolder } from './render.js';
import { GfxDevice } from '../gfx/platform/GfxPlatform.js';
import { SceneContext } from '../SceneBase.js';
import { assertExists } from '../util.js';
import { CameraController } from '../Camera.js';
import * as AnimGroup from './AnimGroup.js';

class SuperPaperMarioRenderer extends WorldRenderer {
    public adjustCameraController(c: CameraController) {
        c.setSceneMoveSpeedMult(24/60);
    }
}

const pathBase = `SuperPaperMario`;
class SPMSceneDesc implements Viewer.SceneDesc {
    constructor(public id: string, public name: string = id) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const dataFetcher = context.dataFetcher;
        const buffer = await dataFetcher.fetchData(`${pathBase}/${this.id}.bin`);
        const decompressed = CX.decompress(buffer);
        const arc = U8.parse(decompressed);
        const dFile = assertExists(arc.findFileData(`./dvd/map/*/map.dat`));
        const d = World.parse(dFile);

        const textureHolder = new TPLTextureHolder();
        const tFile = assertExists(arc.findFileData(`./dvd/map/*/texture.tpl`));
        const tpl = TPL.parse(tFile, d.textureNameTable);
        textureHolder.addTPLTextures(device, tpl);

        const bDir = arc.findDir(`./dvd/bg`);
        let backgroundTextureName: string | null = null;
        if (bDir !== null) {
            for (let i = 0; i < bDir.files.length; i++) {
                const bFile = bDir.files[i];
                const bgTpl = TPL.parse(bFile.buffer, [bFile.name]);
                textureHolder.addTPLTextures(device, bgTpl);
            }

            // TODO(jstpierre): Figure out how the backgrounds are rendered.
            backgroundTextureName = bDir.files[0].name;
        }

        const renderer = new SuperPaperMarioRenderer(device, d, textureHolder, backgroundTextureName);
        renderer.animGroupCache = new AnimGroup.AnimGroupDataCache(device, dataFetcher, 'spm');

        /*
        const agd1 = await renderer.animGroupCache!.requestAnimGroupData('e_3D_manera');
        const agi1 = new AnimGroup.AnimGroupInstance(device, renderer.renderHelper.renderCache, agd1);
        computeModelMatrixS(agi1.modelMatrix, 100);
        renderer.animGroupInstances.push(agi1);

        const label = document.createElement('div');
        label.style.font = '32pt monospace';
        label.style.position = 'absolute';
        label.style.bottom = '48px';
        label.style.right = '16px';
        label.style.color = 'white';
        label.style.textShadow = '0px 0px 4px black';
        label.textContent = '(none)';
        context.uiContainer.appendChild(label);
        */

        /*
        let i = 0;
        setInterval(() => {
            let a = agd1.animGroup.anims[i++];
            if (a === undefined) {
                label.textContent = '(done)';
                return;
            }
            agi1.playAnimation(a.name);
            label.textContent = a.name;
        }, 2000);
        */

        return renderer;
    }
}

// Courses organized by MGMoaks and EruditeWho (@EruditeWhy).
const sceneDescs = [
    "Flipside / Flopside",
    new SPMSceneDesc('mac_22', "Flipside Tower"),
    new SPMSceneDesc('mac_01', "Flipside 3rd Floor"),
    new SPMSceneDesc('mac_02', "Flipside 2nd Floor"),
    new SPMSceneDesc('mac_09', "Flipside 1st Floor"),
    new SPMSceneDesc('mac_04', "Flipside B1"),
    new SPMSceneDesc('mac_05', "Flipside B2"),
    new SPMSceneDesc('mac_06', "Flipside 1st Floor Outskirts"),
    new SPMSceneDesc('mac_08', "Flipside Treasure Room"),
    new SPMSceneDesc('mac_07', "Flipside B1 Outskirts"),
    new SPMSceneDesc('mac_30', "Flipside Arcade"),
    new SPMSceneDesc('mac_03', "Mirror Hall"),
    new SPMSceneDesc('mac_11', "Flopside 3rd Floor"),
    new SPMSceneDesc('mac_12', "Flopside 2nd Floor"),
    new SPMSceneDesc('mac_19', "Flopside 1st Floor"),
    new SPMSceneDesc('mac_14', "Flopside B1"),
    new SPMSceneDesc('mac_15', "Flopside B2"),
    new SPMSceneDesc('mac_16', "Flopside 1st Floor Outskirts"),
    new SPMSceneDesc('mac_18', "Flopside Treasure Room"),
    new SPMSceneDesc('mac_17', "Flopside B1 Outskirts"),

    "Chapter 1 - Lineland",
    new SPMSceneDesc('he1_01', "Lineland Road 1"),
    new SPMSceneDesc('he1_03', "Lineland Road 1 Secret Room"),
    new SPMSceneDesc('he1_06', "Bestovius' House"),
    new SPMSceneDesc('he1_02', "Lineland Road 2"),
    new SPMSceneDesc('he1_04', "Lineland Road 3"),
    new SPMSceneDesc('he1_05', "Lineland Road 4"),
    new SPMSceneDesc('he2_01', "Mount Lineland 1"),
    new SPMSceneDesc('he2_02', "Mount Lineland 2"),
    new SPMSceneDesc('he2_03', "Yold Town"),
    new SPMSceneDesc('he2_08', "Yold Town Secret Room"),
    new SPMSceneDesc('he2_04', "Red's House"),
    new SPMSceneDesc('he2_05', "Green's House"),
    new SPMSceneDesc('he2_06', "Thowmp Hallway"),
    new SPMSceneDesc('he2_09', "Transition Room"),
    new SPMSceneDesc('he2_07', "Thoreau's Room"),
    new SPMSceneDesc('he3_01', "Yold Desert 1"),
    new SPMSceneDesc('he3_02', "Yold Desert 2"),
    new SPMSceneDesc('he3_03', "Yold Desert 3"),
    new SPMSceneDesc('he3_05', "Desert Secret Pipe"),
    new SPMSceneDesc('he3_04', "O'Chunks Arena"),
    new SPMSceneDesc('he3_06', "Yold Desert 4"),
    new SPMSceneDesc('he3_07', "Yold Desert 5"),
    new SPMSceneDesc('he3_08', "Yold Ruins Entrance"),
    new SPMSceneDesc('he4_01', "Yold Ruins 1"),
    new SPMSceneDesc('he4_02', "Yold Ruins 2"),
    new SPMSceneDesc('he4_03', "Yold Ruins 3"),
    new SPMSceneDesc('he4_04', "Yold Ruins 4"),
    new SPMSceneDesc('he4_05', "Yold Ruins 5"),
    new SPMSceneDesc('he4_06', "Yold Ruins 6"),
    new SPMSceneDesc('he4_12', "Yold Ruins 7"),
    new SPMSceneDesc('he4_07', "Yold Ruins 8"),
    new SPMSceneDesc('he4_08', "Yold Ruins 9"),
    new SPMSceneDesc('he4_09', "Yold Ruins 10"),
    new SPMSceneDesc('he4_10', "Fracktail's Arena"),
    new SPMSceneDesc('he4_11', "Merlumina's Chamber"),

    "Chapter 2 - Gloam Valley",
    new SPMSceneDesc('mi1_01', "Gloam Valley 1"),
    new SPMSceneDesc('mi1_05', "Gloam Valley 1 - Pipe Room 1"),
    new SPMSceneDesc('mi1_08', "Gloam Valley 2"),
    new SPMSceneDesc('mi1_09', "Gloam Valley 3"),
    new SPMSceneDesc('mi1_11', "Gloam Valley 4"),
    new SPMSceneDesc('mi1_10', "Gloam Valley 5"),
    new SPMSceneDesc('mi1_06', "Gloam Valley 5 - Pipe Room 1"),
    new SPMSceneDesc('mi1_07', "Gloam Valley 5 - Boomer's Room"),
    new SPMSceneDesc('mi1_02', "Gloam Valley 5 - Maze Room 1"),
    new SPMSceneDesc('mi1_03', "Gloam Valley 5 - Maze Room 2"),
    new SPMSceneDesc('mi1_04', "Gloam Valley 6"),
    new SPMSceneDesc('mi2_01', "Merlee's Mansion Exterior"),
    new SPMSceneDesc('mi2_02', "Merlee's Mansion Foyer"),
    new SPMSceneDesc('mi2_03', "Merlee's Mansion - Hub 1"),
    new SPMSceneDesc('mi2_04', "Merlee's Mansion - Hanging Mushroom Trap 1"),
    new SPMSceneDesc('mi2_11', "Merlee's Mansion - Hanging Mushroom Trap 2"),
    new SPMSceneDesc('mi2_05', "Merlee's Mansion - Coin Trap 1"),
    new SPMSceneDesc('mi2_10', "Merlee's Mansion - Coin Trap 2"),
    new SPMSceneDesc('mi2_06', "Merlee's Mansion - Spike Trap"),
    new SPMSceneDesc('mi2_07', "Merlee's Mansion - Mushroom Trap 1"),
    new SPMSceneDesc('mi2_09', "Merlee's Mansion - Mushroom Trap 2"),
    new SPMSceneDesc('mi2_08', "Merlee's Mansion - Ending Room"),
    new SPMSceneDesc('mi3_01', "Merlee's Mansion - Hub 2"),
    new SPMSceneDesc('mi3_05', "Merlee's Mansion - Mushroom Room"),
    new SPMSceneDesc('mi3_04', "Merlee's Mansion - Standard Generator"),
    new SPMSceneDesc('mi3_02', "Merlee's Mansion - Break Room"),
    new SPMSceneDesc('mi3_03', "Merlee's Mansion - VIP Generator"),
    new SPMSceneDesc('mi3_06', "Merlee's Mansion - Office"),
    new SPMSceneDesc('mi4_01', "Merlee's Basement Entrance"),
    new SPMSceneDesc('mi4_02', "Merlee's Basement - Room 1"),
    new SPMSceneDesc('mi4_03', "Merlee's Basement - Room 2"),
    new SPMSceneDesc('mi4_04', "Merlee's Basement - Room 3"),
    new SPMSceneDesc('mi4_05', "Merlee's Basement - Room 4"),
    new SPMSceneDesc('mi4_06', "Merlee's Basement - Pink Room"),
    new SPMSceneDesc('mi4_09', "Merlee's Basement - Room 5"),
    new SPMSceneDesc('mi4_07', "Merlee's Basement - Room 6"),
    new SPMSceneDesc('mi4_08', "Merlee's Basement - Room 7"),
    new SPMSceneDesc('mi4_10', "Merlee's Basement - Room 8"),
    new SPMSceneDesc('mi4_11', "Merlee's Basement - Room 9"),
    new SPMSceneDesc('mi4_15', "Merlee's Basement - Staircase Room"),
    new SPMSceneDesc('mi4_12', "Merlee's Basement - Restroom Hall"),
    new SPMSceneDesc('mi4_13', "Merlee's Basement - Male Restroom"),
    new SPMSceneDesc('mi4_14', "Merlee's Basement - Female Restroom"),

    "Chapter 3 - The Bitlands",
    new SPMSceneDesc('ta1_01', "The Bitlands 1"),
    new SPMSceneDesc('ta1_05', "The Bitlands 1 - Pipe Room"),
    new SPMSceneDesc('ta1_02', "The Bitlands 2"),
    new SPMSceneDesc('ta1_09', "The Bitlands 3"),
    new SPMSceneDesc('ta1_03', "SMB 1-2 Segment"),
    new SPMSceneDesc('ta1_06', "SMB 1-2 Segment - Pipe Room 1"),
    new SPMSceneDesc('ta1_08', "SMB 1-2 Segment - Pipe Room 2"),
    new SPMSceneDesc('ta1_07', "SMB 1-2 Segment - Pipe Room 3"),
    new SPMSceneDesc('ta1_04', "The Bitlands 4"),
    new SPMSceneDesc('ta2_01', "The Tile Pool 1"),
    new SPMSceneDesc('ta2_02', "The Tile Pool 2"),
    new SPMSceneDesc('ta2_03', "The Tile Pool 3"),
    new SPMSceneDesc('ta2_04', "The Tile Pool 4"),
    new SPMSceneDesc('ta2_05', "The Tile Pool 5"),
    new SPMSceneDesc('ta2_06', "The Tile Pool 6"),
    new SPMSceneDesc('ta3_01', "The Dotwood Tree 1 - Exterior"),
    new SPMSceneDesc('ta3_05', "The Dotwood Tree 1 - Pipe Room"),
    new SPMSceneDesc('ta3_02', "The Dotwood Tree 2 - Interior"),
    new SPMSceneDesc('ta3_06', "The Dotwood Tree 2 - Pipe Room 1"),
    new SPMSceneDesc('ta3_07', "The Dotwood Tree 2 - Pipe Room 2"),
    new SPMSceneDesc('ta3_08', "The Dotwood Tree 2 - Pipe Room 3"),
    new SPMSceneDesc('ta3_03', "The Dotwood Tree 3 - Top"),
    new SPMSceneDesc('ta3_04', "The Dotwood Tree 4 - Level End"),
    new SPMSceneDesc('ta4_01', "Fort Francis - Exterior"),
    new SPMSceneDesc('ta4_02', "Fort Francis - Pipe Room"),
    new SPMSceneDesc('ta4_03', "Fort Francis - Entrance Room"),
    new SPMSceneDesc('ta4_04', "Fort Francis - Cat Door Hallway"),
    new SPMSceneDesc('ta4_05', "Fort Francis - Tower 1"),
    new SPMSceneDesc('ta4_06', "Fort Francis - Hanging Door Hallway"),
    new SPMSceneDesc('ta4_07', "Fort Francis - Tower 2"),
    new SPMSceneDesc('ta4_08', "Fort Francis - Bridge"),
    new SPMSceneDesc('ta4_09', "Fort Francis - Computer Room "),
    new SPMSceneDesc('ta4_15', "Fort Francis - Dungeon Room 1"),
    new SPMSceneDesc('ta4_12', "Fort Francis - Dungeon Room 2"),
    new SPMSceneDesc('ta4_14', "Fort Francis - Spike Hallway"),
    new SPMSceneDesc('ta4_11', "Fort Francis - Collectibles Room 1"),
    new SPMSceneDesc('ta4_10', "Fort Francis - Collectibles Room 2"),
    new SPMSceneDesc('ta4_13', "Fort Francis - Francis's Room"),

    "Chapter 4 - Outer Space",
    new SPMSceneDesc('sp1_01'),
    new SPMSceneDesc('sp1_02'),
    new SPMSceneDesc('sp1_03'),
    new SPMSceneDesc('sp1_04'),
    new SPMSceneDesc('sp1_05'),
    new SPMSceneDesc('sp1_06'),
    new SPMSceneDesc('sp1_07'),
    new SPMSceneDesc('sp2_01'),
    new SPMSceneDesc('sp2_02'),
    new SPMSceneDesc('sp2_03'),
    new SPMSceneDesc('sp2_04'),
    new SPMSceneDesc('sp2_05'),
    new SPMSceneDesc('sp2_06'),
    new SPMSceneDesc('sp2_07'),
    new SPMSceneDesc('sp2_08'),
    new SPMSceneDesc('sp2_09'),
    new SPMSceneDesc('sp2_10'),
    new SPMSceneDesc('sp3_01'),
    new SPMSceneDesc('sp3_02'),
    new SPMSceneDesc('sp3_03'),
    new SPMSceneDesc('sp3_04'),
    new SPMSceneDesc('sp3_05'),
    new SPMSceneDesc('sp3_06'),
    new SPMSceneDesc('sp3_07'),
    new SPMSceneDesc('sp4_01'),
    new SPMSceneDesc('sp4_02'),
    new SPMSceneDesc('sp4_03'),
    new SPMSceneDesc('sp4_04'),
    new SPMSceneDesc('sp4_05'),
    new SPMSceneDesc('sp4_06'),
    new SPMSceneDesc('sp4_07'),
    new SPMSceneDesc('sp4_08'),
    new SPMSceneDesc('sp4_09'),
    new SPMSceneDesc('sp4_10'),
    new SPMSceneDesc('sp4_11'),
    new SPMSceneDesc('sp4_12'),
    new SPMSceneDesc('sp4_13'),
    new SPMSceneDesc('sp4_14'),
    new SPMSceneDesc('sp4_15'),
    new SPMSceneDesc('sp4_16'),
    new SPMSceneDesc('sp4_17'),

    "Chapter 5 - Land of the Cragnons",
    new SPMSceneDesc('gn1_01'),
    new SPMSceneDesc('gn1_02'),
    new SPMSceneDesc('gn1_03'),
    new SPMSceneDesc('gn1_04'),
    new SPMSceneDesc('gn1_05'),
    new SPMSceneDesc('gn2_01'),
    new SPMSceneDesc('gn2_02'),
    new SPMSceneDesc('gn2_03'),
    new SPMSceneDesc('gn2_04'),
    new SPMSceneDesc('gn2_05'),
    new SPMSceneDesc('gn2_06'),
    new SPMSceneDesc('gn3_01'),
    new SPMSceneDesc('gn3_02'),
    new SPMSceneDesc('gn3_03'),
    new SPMSceneDesc('gn3_04'),
    new SPMSceneDesc('gn3_05'),
    new SPMSceneDesc('gn3_06'),
    new SPMSceneDesc('gn3_07'),
    new SPMSceneDesc('gn3_08'),
    new SPMSceneDesc('gn3_09'),
    new SPMSceneDesc('gn3_10'),
    new SPMSceneDesc('gn3_11'),
    new SPMSceneDesc('gn3_12'),
    new SPMSceneDesc('gn3_13'),
    new SPMSceneDesc('gn3_14'),
    new SPMSceneDesc('gn3_15'),
    new SPMSceneDesc('gn3_16'),
    new SPMSceneDesc('gn4_01'),
    new SPMSceneDesc('gn4_02'),
    new SPMSceneDesc('gn4_03'),
    new SPMSceneDesc('gn4_04'),
    new SPMSceneDesc('gn4_05'),
    new SPMSceneDesc('gn4_06'),
    new SPMSceneDesc('gn4_07'),
    new SPMSceneDesc('gn4_08'),
    new SPMSceneDesc('gn4_09'),
    new SPMSceneDesc('gn4_10'),
    new SPMSceneDesc('gn4_11'),
    new SPMSceneDesc('gn4_12'),
    new SPMSceneDesc('gn4_13'),
    new SPMSceneDesc('gn4_14'),
    new SPMSceneDesc('gn4_15'),
    new SPMSceneDesc('gn4_16'),
    new SPMSceneDesc('gn4_17'),

    "Chapter 6 - Sammer's Kingdom",
    new SPMSceneDesc('wa1_01'),
    new SPMSceneDesc('wa1_02'),
    new SPMSceneDesc('wa1_03'),
    new SPMSceneDesc('wa1_04'),
    new SPMSceneDesc('wa2_01'),
    new SPMSceneDesc('wa2_02'),
    new SPMSceneDesc('wa2_03'),
    new SPMSceneDesc('wa3_01'),
    new SPMSceneDesc('wa3_02'),
    new SPMSceneDesc('wa3_03'),
    new SPMSceneDesc('wa4_01'),
    new SPMSceneDesc('wa4_02'),
    new SPMSceneDesc('wa4_03'),

    "Chapter 7 - The Underwhere",
    new SPMSceneDesc('an1_01'),
    new SPMSceneDesc('an1_02'),
    new SPMSceneDesc('an1_03'),
    new SPMSceneDesc('an1_04'),
    new SPMSceneDesc('an1_05'),
    new SPMSceneDesc('an1_06'),
    new SPMSceneDesc('an1_07'),
    new SPMSceneDesc('an1_08'),
    new SPMSceneDesc('an1_09'),
    new SPMSceneDesc('an1_10'),
    new SPMSceneDesc('an1_11'),
    new SPMSceneDesc('an2_01'),
    new SPMSceneDesc('an2_02'),
    new SPMSceneDesc('an2_03'),
    new SPMSceneDesc('an2_04'),
    new SPMSceneDesc('an2_05'),
    new SPMSceneDesc('an2_06'),
    new SPMSceneDesc('an2_07'),
    new SPMSceneDesc('an2_08'),
    new SPMSceneDesc('an2_09'),
    new SPMSceneDesc('an2_10'),
    new SPMSceneDesc('an3_01'),
    new SPMSceneDesc('an3_02'),
    new SPMSceneDesc('an3_03'),
    new SPMSceneDesc('an3_04'),
    new SPMSceneDesc('an3_05'),
    new SPMSceneDesc('an3_06'),
    new SPMSceneDesc('an3_07'),
    new SPMSceneDesc('an3_08'),
    new SPMSceneDesc('an3_09'),
    new SPMSceneDesc('an3_10'),
    new SPMSceneDesc('an3_11'),
    new SPMSceneDesc('an3_12'),
    new SPMSceneDesc('an3_13'),
    new SPMSceneDesc('an3_14'),
    new SPMSceneDesc('an3_15'),
    new SPMSceneDesc('an3_16'),
    new SPMSceneDesc('an4_01'),
    new SPMSceneDesc('an4_02'),
    new SPMSceneDesc('an4_03'),
    new SPMSceneDesc('an4_04'),
    new SPMSceneDesc('an4_05'),
    new SPMSceneDesc('an4_06'),
    new SPMSceneDesc('an4_07'),
    new SPMSceneDesc('an4_08'),
    new SPMSceneDesc('an4_09'),
    new SPMSceneDesc('an4_10'),
    new SPMSceneDesc('an4_11'),
    new SPMSceneDesc('an4_12'),

    "Chapter 8 - Castle Bleck",
    new SPMSceneDesc('ls1_01'),
    new SPMSceneDesc('ls1_02'),
    new SPMSceneDesc('ls1_03'),
    new SPMSceneDesc('ls1_04'),
    new SPMSceneDesc('ls1_05'),
    new SPMSceneDesc('ls1_06'),
    new SPMSceneDesc('ls1_07'),
    new SPMSceneDesc('ls1_08'),
    new SPMSceneDesc('ls1_09'),
    new SPMSceneDesc('ls1_10'),
    new SPMSceneDesc('ls1_11'),
    new SPMSceneDesc('ls1_12'),
    new SPMSceneDesc('ls2_01'),
    new SPMSceneDesc('ls2_02'),
    new SPMSceneDesc('ls2_03'),
    new SPMSceneDesc('ls2_04'),
    new SPMSceneDesc('ls2_05'),
    new SPMSceneDesc('ls2_06'),
    new SPMSceneDesc('ls2_07'),
    new SPMSceneDesc('ls2_08'),
    new SPMSceneDesc('ls2_09'),
    new SPMSceneDesc('ls2_10'),
    new SPMSceneDesc('ls2_11'),
    new SPMSceneDesc('ls2_12'),
    new SPMSceneDesc('ls2_13'),
    new SPMSceneDesc('ls2_14'),
    new SPMSceneDesc('ls2_15'),
    new SPMSceneDesc('ls2_16'),
    new SPMSceneDesc('ls2_17'),
    new SPMSceneDesc('ls2_18'),
    new SPMSceneDesc('ls3_01'),
    new SPMSceneDesc('ls3_02'),
    new SPMSceneDesc('ls3_03'),
    new SPMSceneDesc('ls3_04'),
    new SPMSceneDesc('ls3_05'),
    new SPMSceneDesc('ls3_06'),
    new SPMSceneDesc('ls3_07'),
    new SPMSceneDesc('ls3_08'),
    new SPMSceneDesc('ls3_09'),
    new SPMSceneDesc('ls3_10'),
    new SPMSceneDesc('ls3_11'),
    new SPMSceneDesc('ls3_12'),
    new SPMSceneDesc('ls3_13'),
    new SPMSceneDesc('ls4_01'),
    new SPMSceneDesc('ls4_02'),
    new SPMSceneDesc('ls4_03'),
    new SPMSceneDesc('ls4_04'),
    new SPMSceneDesc('ls4_05'),
    new SPMSceneDesc('ls4_06'),
    new SPMSceneDesc('ls4_07'),
    new SPMSceneDesc('ls4_08'),
    new SPMSceneDesc('ls4_09'),
    new SPMSceneDesc('ls4_10'),
    new SPMSceneDesc('ls4_11'),
    new SPMSceneDesc('ls4_12'),
    new SPMSceneDesc('ls4_13'),

    "Pit of 100 Trials",
    new SPMSceneDesc('dan_01'),
    new SPMSceneDesc('dan_02'),
    new SPMSceneDesc('dan_03'),
    new SPMSceneDesc('dan_04'),
    new SPMSceneDesc('dan_11'),
    new SPMSceneDesc('dan_12'),
    new SPMSceneDesc('dan_13'),
    new SPMSceneDesc('dan_14'),
    new SPMSceneDesc('dan_21'),
    new SPMSceneDesc('dan_22'),
    new SPMSceneDesc('dan_23'),
    new SPMSceneDesc('dan_24'),
    new SPMSceneDesc('dan_30'),
    new SPMSceneDesc('dan_41'),
    new SPMSceneDesc('dan_42'),
    new SPMSceneDesc('dan_43'),
    new SPMSceneDesc('dan_44'),
    new SPMSceneDesc('dan_61'),
    new SPMSceneDesc('dan_62'),
    new SPMSceneDesc('dan_63'),
    new SPMSceneDesc('dan_64'),
    new SPMSceneDesc('dan_70'),

    "Storybook Pages",
    new SPMSceneDesc('mg1_01'),
    new SPMSceneDesc('mg2_01'),
    new SPMSceneDesc('mg2_02'),
    new SPMSceneDesc('mg2_03'),
    new SPMSceneDesc('mg2_04'),
    new SPMSceneDesc('mg2_05'),
    new SPMSceneDesc('mg3_01'),
    new SPMSceneDesc('mg3_02'),
    new SPMSceneDesc('mg3_03'),
    new SPMSceneDesc('mg3_04'),
    new SPMSceneDesc('mg3_05'),
    new SPMSceneDesc('mg4_01'),

    "Cutscenes",
    new SPMSceneDesc('aa1_01', "Outside Mario's House"),
    new SPMSceneDesc('aa1_02', "Inside Mario's House"),
    new SPMSceneDesc('aa2_01', "Outside Bowser's Castle"),
    new SPMSceneDesc('aa2_02', "Inside Bowser's Castle"),
    new SPMSceneDesc('aa3_01', "The End"),
    new SPMSceneDesc('aa4_01', "Magic Tome"),
    new SPMSceneDesc('go1_01', "Game Over (Japanese)"),
    new SPMSceneDesc('go1_02', "Game Over (English)"),
    new SPMSceneDesc('go1_03', "Game Over (PAL)"),

    "Unused Maps",
    new SPMSceneDesc('bos_01'),
    new SPMSceneDesc('dos_01'),

    "Cat Adventure Prototype (Korean Exclusive)",
    new SPMSceneDesc('kri_00'),
    new SPMSceneDesc('kri_01'),
    new SPMSceneDesc('kri_02'),
    new SPMSceneDesc('kri_03'),
    new SPMSceneDesc('kri_04'),
    new SPMSceneDesc('kri_05'),
    new SPMSceneDesc('kri_06'),
    new SPMSceneDesc('kri_07'),
    new SPMSceneDesc('kri_08'),
    new SPMSceneDesc('kri_09'),
    new SPMSceneDesc('kri_10'),
];

const id = 'spm';
const name = 'Super Paper Mario';
export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs };
