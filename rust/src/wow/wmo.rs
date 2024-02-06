use deku::{prelude::*, ctx::ByteSize};
use wasm_bindgen::prelude::*;

use crate::wow::common::ChunkedData;

use super::common::{Argb, AABBox, Vec3, Quat};

#[wasm_bindgen(js_name = "WowWmoHeader")]
#[derive(DekuRead, Debug, Copy, Clone)]
pub struct WmoHeader {
    pub num_textures: u32,
    pub num_groups: u32,
    pub num_portals: u32,
    pub num_lights: u32,
    pub num_doodad_names: u32,
    pub num_doodad_defs: u32,
    pub num_doodad_sets: u32,
    pub ambient_color: Argb,
    pub wmo_id: u32,
    pub bounding_box: AABBox,
    pub flags: u16,
    pub num_lod: u16,
}

#[wasm_bindgen(js_class = "WowWmoHeader")]
impl WmoHeader {
    pub fn get_flags(&self) -> WmoHeaderFlags {
        WmoHeaderFlags::new(self.flags)
    }
}

#[wasm_bindgen(js_name = "WowWmoHeaderFlags")]
pub struct WmoHeaderFlags {
    attenuate_vertices_based_on_distance_to_portal: bool,
    skip_base_color: bool,
    use_liquid_type_dbc_id: bool,
    lighten_interiors: bool,
    lod: bool,
}

impl WmoHeaderFlags {
    pub fn new(x: u16) -> Self {
        Self {
            attenuate_vertices_based_on_distance_to_portal: x & 0x01 > 0,
            skip_base_color: x & 0x02 > 0,
            use_liquid_type_dbc_id: x & 0x04 > 0,
            lighten_interiors: x & 0x08 > 0,
            lod: x & 0x10 > 0,
        }
    }
}

#[wasm_bindgen(js_name = "WowWmo", getter_with_clone)]
#[derive(Debug, Clone)]
pub struct Wmo {
    pub header: WmoHeader,
    pub textures: Vec<WmoMaterial>,
    pub group_infos: Vec<GroupInfo>,
    pub group_file_ids: Vec<u32>,
    pub doodad_defs: Vec<DoodadDef>,
    pub doodad_file_ids: Vec<u32>,
    pub fogs: Vec<Fog>,
    pub skybox_file_id: Option<u32>,
    global_ambient_volumes: Vec<AmbientVolume>,
    ambient_volumes: Vec<AmbientVolume>,
}

#[wasm_bindgen(js_class = "WowWmo")]
impl Wmo {
    pub fn new(data: Vec<u8>) -> Result<Wmo, String> {
        let mut chunked_data = ChunkedData::new(&data);
        let (mver, _) = chunked_data.next().unwrap();
        assert_eq!(mver.magic_str(), "REVM");
        let (mhdr, mhdr_data) = chunked_data.next().unwrap();
        assert_eq!(mhdr.magic_str(), "DHOM");
        let header: WmoHeader = mhdr.parse(mhdr_data)?;
        let mut momt: Option<Vec<WmoMaterial>> = None;
        let mut mogi: Option<Vec<GroupInfo>> = None;
        let mut modd: Option<Vec<DoodadDef>> = None;
        let mut mfog: Option<Vec<Fog>> = None;
        let mut modi: Option<Vec<u32>> = None;
        let mut gfid: Option<Vec<u32>> = None;
        let mut mavg: Vec<AmbientVolume> = Vec::new();
        let mut mavd: Vec<AmbientVolume> = Vec::new();
        let mut mosi: Option<Mosi> = None;
        for (chunk, chunk_data) in &mut chunked_data {
            match &chunk.magic {
                b"TMOM" => momt = Some(chunk.parse_array(chunk_data, 0x40)?),
                b"IGOM" => mogi = Some(chunk.parse_array(chunk_data, 0x20)?),
                b"DDOM" => modd = Some(chunk.parse_array(chunk_data, 40)?),
                b"GOFM" => mfog = Some(chunk.parse_array(chunk_data, 48)?),
                b"IDOM" => modi = Some(chunk.parse_array(chunk_data, 4)?),
                b"DIFG" => gfid = Some(chunk.parse_array(chunk_data, 4)?),
                b"DVAM" => mavd = chunk.parse_array(chunk_data, 0x30)?,
                b"GVAM" => mavg = chunk.parse_array(chunk_data, 0x30)?,
                b"ISOM" => mosi = Some(chunk.parse(chunk_data)?),
                _ => println!("skipping {} chunk", chunk.magic_str()),
            }
        }
        Ok(Wmo {
            header,
            textures: momt.ok_or("WMO file didn't have MOMT chunk")?,
            group_infos: mogi.ok_or("WMO file didn't have MOGI chunk")?,
            doodad_defs: modd.ok_or("WMO file didn't have MODD chunk")?,
            doodad_file_ids: modi.unwrap_or(vec![]),
            fogs: mfog.ok_or("WMO file didn't have MFOG chunk")?,
            group_file_ids: gfid.ok_or("WMO file didn't have group ids")?,
            skybox_file_id: mosi.map(|m| m.skybox_file_id),
            global_ambient_volumes: mavg,
            ambient_volumes: mavd,
        })
    }

    pub fn get_ambient_color(&self, doodad_set_id: u16) -> Argb {
        match self.global_ambient_volumes.iter().find(|av| av.doodad_set_id == doodad_set_id) {
            Some(av) => av.get_color(),
            None => self.header.ambient_color,
        }
    }
}

#[derive(DekuRead)]
pub struct Mosi {
    pub skybox_file_id: u32,
}

#[wasm_bindgen(js_name = "WowWmoGroup", getter_with_clone)]
#[derive(Debug, Clone)]
pub struct WmoGroup {
    pub header: WmoGroupHeader,
    pub material_info: Vec<MaterialInfo>,
    pub indices: Vec<u8>,
    pub vertices: Vec<u8>,
    pub num_vertices: usize,
    pub normals: Vec<u8>,
    pub uvs: Vec<u8>,
    pub num_uv_bufs: usize,
    pub colors: Vec<u8>,
    pub num_color_bufs: usize,
    pub first_color_buf_len: Option<usize>,
    pub batches: Vec<MaterialBatch>,
    pub doodad_refs: Vec<u16>,
    pub replacement_for_header_color: Option<Argb>,
}

#[wasm_bindgen(js_class = "WowWmoGroup")]
impl WmoGroup {
    pub fn new(data: Vec<u8>) -> Result<WmoGroup, String> {
        let mut chunked_data = ChunkedData::new(&data);
        let (mver, _) = chunked_data.next().unwrap();
        assert_eq!(mver.magic_str(), "REVM");
        let (mhdr, mhdr_data) = chunked_data.next().unwrap();
        let header: WmoGroupHeader = mhdr.parse(mhdr_data)?;
        let mut mopy: Option<Vec<MaterialInfo>> = None;
        let mut indices: Option<Vec<u8>> = None;
        let mut vertices: Option<Vec<u8>> = None;
        let mut normals: Option<Vec<u8>> = None;
        let mut uvs: Vec<u8> = Vec::new();
        let mut num_uv_bufs = 0;
        let mut colors: Vec<u8> = Vec::new();
        let mut first_color_buf_len: Option<usize> = None;
        let mut num_vertices = 0;
        let mut num_color_bufs = 0;
        let mut batches: Option<Vec<MaterialBatch>> = None;
        let mut replacement_for_header_color: Option<Argb> = None;
        let mut doodad_refs: Option<Vec<u16>> = None;
        let mut chunked_data = ChunkedData::new(&data[0x58..]);
        for (chunk, chunk_data) in &mut chunked_data {
            match &chunk.magic {
                b"YPOM" => mopy = Some(chunk.parse_array(chunk_data, 2)?),
                b"IVOM" => indices = Some(chunk_data.to_vec()),
                b"LADM" => replacement_for_header_color = Some(chunk.parse(chunk_data)?),
                b"TVOM" => {
                    num_vertices = chunk_data.len();
                    vertices = Some(chunk_data.to_vec());
                },
                b"RNOM" => normals = Some(chunk_data.to_vec()),
                b"VTOM" => {
                    num_uv_bufs += 1;
                    uvs.extend(chunk_data.to_vec());
                },
                b"VCOM" => {
                    colors.extend(chunk_data.to_vec());
                    if first_color_buf_len.is_none() {
                        first_color_buf_len = Some(colors.len() / 4);
                    }
                    num_color_bufs += 1;
                },
                b"ABOM" => batches = Some(chunk.parse_array(chunk_data, 24)?),
                b"RDOM" => doodad_refs = Some(chunk.parse_array(chunk_data, 2)?),
                _ => println!("skipping {}", chunk.magic_str()),
            }
        }

        assert!(num_uv_bufs > 0);

        Ok(WmoGroup {
            header,
            material_info: mopy.ok_or("WMO group didn't have MOPY chunk")?,
            indices: indices.ok_or("WMO group didn't have indices")?,
            vertices: vertices.ok_or("WMO group didn't have vertices")?,
            num_vertices,
            normals: normals.ok_or("WMO group didn't have normals")?,
            replacement_for_header_color,
            first_color_buf_len,
            uvs,
            num_uv_bufs,
            colors,
            num_color_bufs,
            batches: batches.unwrap_or(vec![]),
            doodad_refs: doodad_refs.unwrap_or(vec![]),
        })
    }

    pub fn fix_color_vertex_alpha(&mut self, wmo_header: &WmoHeader) {
        let num_colors = match self.first_color_buf_len {
            Some(n) => n,
            None => { return; }
        };

        let wmo_flags = WmoHeaderFlags::new(wmo_header.flags);
        let group_flags = WmoGroupFlags::new(self.header.flags);

        let mut begin_second_fixup = 0;
        if self.header.trans_batch_count > 0 {
            begin_second_fixup = self.batches[self.header.trans_batch_count as usize - 1].last_vertex + 1;
        }

        let mut r_diff: u8 = 0;
        let mut g_diff: u8 = 0;
        let mut b_diff: u8 = 0;

        if (wmo_flags.lighten_interiors) {
            for i in begin_second_fixup as usize..num_colors {
                if group_flags.exterior {
                    self.colors[i*4 + 3] = 0xff;
                } else {
                    self.colors[i*4 + 3] = 0x00;
                }
            }
        } else {
            if !wmo_flags.skip_base_color {
                r_diff = wmo_header.ambient_color.r;
                g_diff = wmo_header.ambient_color.g;
                b_diff = wmo_header.ambient_color.b;
            }

            for i in 0..begin_second_fixup as usize {
                let r_index = i*4 + 2;
                let g_index = i*4 + 1;
                let b_index = i*4 + 0;
                let a_index = i*4 + 3;
                self.colors[r_index] -= r_diff;
                self.colors[g_index] -= g_diff;
                self.colors[b_index] -= b_diff;
                let a = self.colors[a_index] as f32 / 255.0;

                let scaled_r = self.colors[r_index] as f32 - a * self.colors[r_index] as f32;
                assert!(scaled_r > -0.5);
                assert!(scaled_r < 255.5);
                self.colors[r_index] = (scaled_r / 2.0).floor().max(0.0) as u8;

                let scaled_g = self.colors[g_index] as f32 - a * self.colors[g_index] as f32;
                assert!(scaled_g > -0.5);
                assert!(scaled_g < 255.5);
                self.colors[g_index] = (scaled_g / 2.0).floor().max(0.0) as u8;

                let scaled_b = self.colors[b_index] as f32 - a * self.colors[b_index] as f32;
                assert!(scaled_b > -0.5);
                assert!(scaled_b < 255.5);
                self.colors[b_index] = (scaled_b / 2.0).floor().max(0.0) as u8;
            }

            for i in begin_second_fixup as usize..num_colors {
                let r_index = i*4 + 2;
                let g_index = i*4 + 1;
                let b_index = i*4 + 0;
                let a_index = i*4 + 3;
                let r = self.colors[r_index] as f32;
                let g = self.colors[g_index] as f32;
                let b = self.colors[b_index] as f32;
                let a = self.colors[a_index] as f32;

                let scaled_r = (r * a) / 64.0 + r - r_diff as f32;
                self.colors[r_index] = (scaled_r / 2.0).max(0.0).min(255.0) as u8;

                let scaled_g = (g * a) / 64.0 + g - g_diff as f32;
                self.colors[g_index] = (scaled_g / 2.0).max(0.0).min(255.0) as u8;

                let scaled_b = (b * a) / 64.0 + b - b_diff as f32;
                self.colors[b_index] = (scaled_b / 2.0).max(0.0).min(255.0) as u8;

                if group_flags.exterior {
                    self.colors[a_index] = 0xff;
                } else {
                    self.colors[a_index] = 0;
                }
            }
        }
    }
}

#[derive(DekuRead, Debug, Clone)]
pub struct DoodadSet {
    pub name: [u8; 0x14],
    pub start_index: u32,
    #[deku(pad_bytes_after = "4")]
    pub count: u32,
}

#[derive(DekuRead, Debug, Clone)]
pub struct AmbientVolume {
    pub position: Vec3,
    pub start: f32,
    pub end: f32,
    pub color1: Argb,
    pub color2: Argb,
    pub color3: Argb,
    pub flags: u32,
    #[deku(pad_bytes_after = "10")]
    pub doodad_set_id: u16,
}

impl AmbientVolume {
    pub fn get_color(&self) -> Argb {
        if self.flags & 1 > 0 {
            self.color3
        } else {
            self.color1
        }
    }
}

#[wasm_bindgen(js_name = "WowWmoMaterialPixelShader")]
#[derive(Copy, Clone, Debug)]
pub enum PixelShader {
    Diffuse = 0,
    Specular = 1,
    Metal = 2,
    Env = 3,
    Opaque = 4,
    EnvMetal = 5,
    TwoLayerDiffuse = 6, //MapObjComposite
    TwoLayerEnvMetal = 7,
    TwoLayerTerrain = 8,
    DiffuseEmissive = 9,
    MaskedEnvMetal = 10,
    EnvMetalEmissive = 11,
    TwoLayerDiffuseOpaque = 12,
    TwoLayerDiffuseEmissive = 13,
    AdditiveMaskedEnvMetal = 14,
    TwoLayerDiffuseMod2x = 15,
    TwoLayerDiffuseMod2xNA = 16,
    TwoLayerDiffuseAlpha = 17,
    Lod = 18,
    Parallax = 19,
    UnkShader = 20,
    None = 21,
}

#[wasm_bindgen(js_name = "WowWmoMaterialVertexShader")]
#[derive(Copy, Clone, Debug)]
pub enum VertexShader {
    DiffuseT1 = 0,
    DiffuseT1Refl = 1,
    DiffuseT1EnvT2 = 2,
    SpecularT1 = 3,
    DiffuseComp = 4,
    DiffuseCompRefl = 5,
    DiffuseCompTerrain = 6,
    DiffuseCompAlpha = 7,
    Parallax = 8,
    None = 9,
}

static STATIC_SHADERS: [(VertexShader, PixelShader); 24] = [
    (VertexShader::DiffuseT1, PixelShader::Diffuse),
    (VertexShader::SpecularT1, PixelShader::Specular),
    (VertexShader::SpecularT1, PixelShader::Metal),
    (VertexShader::DiffuseT1Refl, PixelShader::Env),
    (VertexShader::DiffuseT1, PixelShader::Opaque),
    (VertexShader::DiffuseT1Refl, PixelShader::EnvMetal),
    (VertexShader::DiffuseComp, PixelShader::TwoLayerDiffuse),
    (VertexShader::DiffuseT1, PixelShader::TwoLayerEnvMetal),
    (VertexShader::DiffuseCompTerrain, PixelShader::TwoLayerTerrain),
    (VertexShader::DiffuseComp, PixelShader::DiffuseEmissive),
    (VertexShader::None, PixelShader::None),
    (VertexShader::DiffuseT1EnvT2, PixelShader::MaskedEnvMetal),
    (VertexShader::DiffuseT1EnvT2, PixelShader::EnvMetalEmissive),
    (VertexShader::DiffuseComp, PixelShader::TwoLayerDiffuseOpaque),
    (VertexShader::None, PixelShader::None),
    (VertexShader::DiffuseComp, PixelShader::TwoLayerDiffuseEmissive),
    (VertexShader::DiffuseT1, PixelShader::Diffuse),
    (VertexShader::DiffuseT1EnvT2, PixelShader::AdditiveMaskedEnvMetal),
    (VertexShader::DiffuseCompAlpha, PixelShader::TwoLayerDiffuseMod2x),
    (VertexShader::DiffuseComp, PixelShader::TwoLayerDiffuseMod2xNA),
    (VertexShader::DiffuseCompAlpha, PixelShader::TwoLayerDiffuseAlpha),
    (VertexShader::DiffuseT1, PixelShader::Lod),
    (VertexShader::Parallax, PixelShader::Parallax),
    (VertexShader::DiffuseT1, PixelShader::UnkShader),
];

#[wasm_bindgen(js_name = "WowWmoMaterialBatch")]
#[derive(DekuRead, Debug, Clone)]
pub struct MaterialBatch {
    unknown: [u8; 0xA],
    pub material_id_large: u16,
    pub start_index: u32,
    pub index_count: u16,
    pub first_vertex: u16,
    pub last_vertex: u16,
    pub use_material_id_large: u8,
    pub material_id: u8,
}

#[wasm_bindgen(js_name = "WowWmoMaterialInfo")]
#[derive(DekuRead, Debug, Clone)]
pub struct MaterialInfo {
    pub flags: u8,
    pub material_id: u8, // index into MOMT, or 0xff for collision faces
}

#[wasm_bindgen(js_name = "WowWmoGroupHeader", getter_with_clone)]
#[derive(DekuRead, Debug, Clone)]
pub struct WmoGroupHeader {
    pub group_name: u32, // offset to MOGN
    pub descriptive_group_name: u32, // offset to MOGN
    pub flags: u32,
    pub bounding_box: AABBox,
    pub portal_start: u16,
    pub portal_count: u16,
    pub trans_batch_count: u16,
    pub int_batch_count: u16,
    pub ext_batch_count: u16,
    pub padding_or_batch_type_d: u16,
    fog_ids: [u8; 4],
    pub group_liquid: u32,
    pub group_flags2: u32,
    pub parent_or_first_child_split_group_index: u16,
    pub next_split_child_group_index: u16,
}

#[wasm_bindgen(js_name = "WowWmoGroupFlags")]
pub struct WmoGroupFlags {
    pub has_bsp_tree: bool,
    pub has_light_map: bool,
    pub has_vertex_colors: bool,
    pub exterior: bool,
    pub exterior_lit: bool, // do not use local diffuse lighting
    pub show_exterior_sky: bool,
    pub has_lights: bool,
    pub has_doodads: bool,
    pub has_water: bool,
    pub interior: bool,
}

#[wasm_bindgen(js_class = "WowWmoGroupFlags")]
impl WmoGroupFlags {
    pub fn new(x: u32) -> Self {
        Self {
            has_bsp_tree: x & 0x1 > 0,
            has_light_map: x & 0x2 > 0,
            has_vertex_colors: x & 0x4 > 0,
            exterior: x & 0x8 > 0,
            exterior_lit: x & 0x40 > 0,
            show_exterior_sky: x & 0x100 > 0,
            has_lights: x & 0x200 > 0,
            has_doodads: x & 0x800 > 0,
            has_water: x & 0x1000 > 0,
            interior: x & 0x2000 > 0,
        }
    }
}

#[derive(DekuRead, Debug)]
#[deku(ctx = "ByteSize(size): ByteSize")]
pub struct DoodadIds {
    #[deku(count = "size / 4")]
    pub file_ids: Vec<u32>,
}

#[wasm_bindgen(js_name = "WowWmoFog")]
#[derive(DekuRead, Debug, Clone)]
pub struct Fog {
    pub flags: u32,
    pub position: Vec3,
    pub smaller_radius: f32,
    pub larger_radius: f32,
    pub fog_end: f32,
    pub fog_start_scalar: f32,
    pub fog_color: Argb,
    pub uw_fog_end: f32,
    pub uw_fog_start_scalar: f32,
    pub uw_fog_color: Argb,
}

#[wasm_bindgen(js_name = "WowDoodadDef")]
#[derive(DekuRead, Debug, Clone)]
pub struct DoodadDef {
    pub name_index: u32,
    pub position: Vec3,
    pub orientation: Quat,
    pub scale: f32,
    pub color: Argb, // BRGRA
}

#[wasm_bindgen(js_name = "WowWmoGroupInfo")]
#[derive(DekuRead, Debug, Clone)]
pub struct GroupInfo {
    pub flags: u32,
    pub bounding_box: AABBox,
    pub name_offset: i32, // offset in the MOGN chunk
}

#[wasm_bindgen(js_name = "WowWmoMaterialFlags")]
#[derive(Debug, Clone)]
pub struct WmoMaterialFlags {
    pub unlit: bool,
    pub unfogged: bool,
    pub unculled: bool,
    pub exterior_light: bool,
    pub sidn: bool,
    pub window: bool,
    pub clamp_s: bool,
    pub clamp_t: bool,
}

#[wasm_bindgen(js_class = "WowWmoMaterialFlags")]
impl WmoMaterialFlags {
    pub fn new(x: u32) -> Self {
        Self {
            unlit:          (x & (1 << 0)) > 0,
            unfogged:       (x & (1 << 1)) > 0,
            unculled:       (x & (1 << 2)) > 0,
            exterior_light: (x & (1 << 3)) > 0,
            sidn:           (x & (1 << 4)) > 0,
            window:         (x & (1 << 5)) > 0,
            clamp_s:        (x & (1 << 6)) > 0,
            clamp_t:        (x & (1 << 7)) > 0,
        }
    }
}

#[wasm_bindgen(js_name = "WowWmoMaterial")]
#[derive(DekuRead, Debug, Clone, Copy)]
pub struct WmoMaterial {
    pub flags: u32,
    pub shader_index: u32,
    pub blend_mode: u32,
    pub texture_1: u32,
    pub sidn_color: Argb,
    pub frame_sidn_color: Argb,
    pub texture_2: u32,
    pub diff_color: Argb,
    pub ground_type: u32,
    pub texture_3: u32,
    pub color_2: Argb,
    pub flags_2: u32,
    runtime_data: [u32; 4],
}

#[wasm_bindgen(js_class = "WowWmoMaterial")]
impl WmoMaterial {
    pub fn get_vertex_shader(&self) -> VertexShader {
        STATIC_SHADERS[self.shader_index as usize].0
    }

    pub fn get_pixel_shader(&self) -> PixelShader {
        STATIC_SHADERS[self.shader_index as usize].1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test() {
        let wmoData = std::fs::read("C:/Users/ifnsp/dev/noclip.website/data/wow/world/wmo/dungeon/md_mountaincave/md_mushroomcave03.wmo").unwrap();
        let groupData = std::fs::read("C:/Users/ifnsp/dev/noclip.website/data/wow/world/wmo/dungeon/md_mountaincave/md_mushroomcave03_000.wmo").unwrap();
        let wmo = Wmo::new(wmoData).unwrap();
        dbg!(wmo.group_infos);
        let mut group = WmoGroup::new(groupData).unwrap();
    }
}
