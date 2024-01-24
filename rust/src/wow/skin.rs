use deku::prelude::*;
use wasm_bindgen::prelude::*;
use super::common::{
    WowArray,
    WowCharArray,
    AABBox,
    Vec3,
    Vec2,
};

#[wasm_bindgen(js_name = "WowSkinSubmesh")]
#[derive(Debug, DekuRead, Clone)]
pub struct SkinSubmesh {
    pub skin_submesh_id: u16,
    pub level: u16, // (level << 16) is added to index_start to avoid having that field be u32
    pub vertex_start: u16,
    pub vertex_count: u16,
    pub index_start: u16,
    pub index_count: u16,
    pub bone_count: u16,
    pub bone_combo_index: u16,
    pub bone_influences: u16,
    pub center_bone_index: u16,
    pub center_position: Vec3,
    pub sort_center_position: Vec3,
    pub sort_radius: f32,
}

#[wasm_bindgen(js_class = "WowSkinSubmesh")]
impl SkinSubmesh {
    pub fn get_index_start(&self) -> u32 {
        let index_start = self.index_start as u32;
        let level = self.level as u32;
        (index_start + (level << 16)) * 2
    }
}

#[derive(Debug, DekuRead)]
#[deku(magic = b"SKIN")]
pub struct SkinProfile {
    vertices: WowArray<u16>,
    indices: WowArray<u16>,
    bones: WowArray<[u8; 4]>,
    submeshes: WowArray<SkinSubmesh>,
    batches: WowArray<ModelBatch>,
    pub bone_count_max: u32,
}

#[wasm_bindgen(js_name = "WowSkin")]
#[derive(Debug)]
pub struct Skin {
    data: Vec<u8>,
    #[wasm_bindgen(getter_with_clone)] pub submeshes: Vec<SkinSubmesh>,
    #[wasm_bindgen(getter_with_clone)] pub batches: Vec<ModelBatch>,
    profile: SkinProfile,
}

#[wasm_bindgen(js_class = "WowSkin")]
impl Skin {
    pub fn new(data: Vec<u8>) -> Result<Skin, String> {
        let (_, profile) = SkinProfile::from_bytes((&data, 0))
            .map_err(|e| format!("{:?}", e))?;
        let batches = profile.batches.to_vec(&data)
            .map_err(|e| format!("{:?}", e))?;
        let submeshes = profile.submeshes.to_vec(&data)
            .map_err(|e| format!("{:?}", e))?;
        Ok(Skin {
            data,
            batches,
            submeshes,
            profile,
        })
    }

    pub fn get_indices(&self) -> Result<Vec<u16>, String> {
        let global_vertex_indices = self.profile.vertices.to_vec(&self.data[..])
            .map_err(|e| format!("{:?}", e))?;
        let local_vertex_indices = self.profile.indices.to_vec(&self.data[..])
            .map_err(|e| format!("{:?}", e))?;
        let mut result = Vec::with_capacity(local_vertex_indices.len());
        for local_idx in local_vertex_indices {
            result.push(global_vertex_indices[local_idx as usize]);
        }
        Ok(result)
    }
}

#[wasm_bindgen(js_name = "WowPixelShader")]
#[derive(Debug, Clone)]
pub enum PixelShader {
    Opaque,
    Decal,
    Add,
    Mod2x,
    Fade,
    Mod,
    Opaque_Opaque,
    Opaque_Add,
    Opaque_Mod2x,
    Opaque_Mod2xNA,
    Opaque_AddNA,
    Opaque_Mod,
    Mod_Opaque,
    Mod_Add,
    Mod_Mod2x,
    Mod_Mod2xNA,
    Mod_AddNA,
    Mod_Mod,
    Add_Mod,
    Mod2x_Mod2x,
    Opaque_Mod2xNA_Alpha,
    Opaque_AddAlpha,
    Opaque_AddAlpha_Alpha,
}

#[wasm_bindgen(js_name = "WowModelBatch")]
#[derive(Debug, DekuRead, Clone, Copy)]
pub struct ModelBatch {
    pub flags: u8,
    pub priority_plane: u8,
    pub shader_id: u16,
    pub skin_submesh_index: u16,
    pub geoset_index: u16,
    pub color_index: u16,
    pub material_index: u16,
    pub material_layer: u16,
    pub texture_count: u16, // 1-4
    pub texture_combo_index: u16, // index into an M2 texture_lookup_table
    pub texture_coord_combo_index: u16, // index into an M2 texture_mapping_lookup_table
    pub texture_weight_combo_index: u16, // index into an M2 transparency_lookup_table
    pub texture_transform_combo_index: u16,// index into an M2 texture_transforms_lookup_table
}

#[wasm_bindgen(js_class = "WowModelBatch")]
impl ModelBatch {
    pub fn get_pixel_shader(&self) -> Option<PixelShader> {
        let tex1_mode = (self.shader_id >> 4) & 7;
        let tex2_mode = self.shader_id & 7;
        use PixelShader as P;
        match (self.texture_count, tex1_mode, tex2_mode) {
            (1, 0, _) => Some(P::Opaque),
            (1, 2, _) => Some(P::Decal),
            (1, 3, _) => Some(P::Add),
            (1, 4, _) => Some(P::Mod2x),
            (1, 5, _) => Some(P::Fade),
            (1, _, _) => Some(P::Mod),
            (_, 0, 0) => Some(P::Opaque_Opaque),
            (_, 0, 3) => Some(P::Opaque_Add),
            (_, 0, 4) => Some(P::Opaque_Mod2x),
            (_, 0, 6) => Some(P::Opaque_Mod2xNA),
            (_, 0, 7) => Some(P::Opaque_AddNA),
            (_, 0, _) => Some(P::Opaque_Mod),
            (_, 1, 0) => Some(P::Mod_Opaque),
            (_, 1, 3) => Some(P::Mod_Add),
            (_, 1, 4) => Some(P::Mod_Mod2x),
            (_, 1, 6) => Some(P::Mod_Mod2xNA),
            (_, 1, 7) => Some(P::Mod_AddNA),
            (_, 1, _) => Some(P::Mod_Mod),
            (_, 3, 1) => Some(P::Add_Mod),
            (_, 4, 4) => Some(P::Mod2x_Mod2x),
            (_, _, 1) => Some(P::Mod_Mod2x),
            _ => None,
        }
    }
}
