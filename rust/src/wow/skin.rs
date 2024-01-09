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
    batches: WowArray<Batch>,
    pub bone_count_max: u32,
}

#[wasm_bindgen(js_name = "WowSkin")]
#[derive(Debug)]
pub struct Skin {
    data: Vec<u8>,
    #[wasm_bindgen(getter_with_clone)] pub submeshes: Vec<SkinSubmesh>,
    #[wasm_bindgen(getter_with_clone)] pub batches: Vec<Batch>,
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

#[wasm_bindgen(js_name = "WowBatch")]
#[derive(Debug, DekuRead, Clone, Copy)]
pub struct Batch {
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
