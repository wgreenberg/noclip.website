use deku::prelude::*;
use wasm_bindgen::prelude::*;
use crate::wow::common::ChunkedData;

use super::common::{
    WowArray,
    WowCharArray,
    AABBox,
    Vec3,
    Vec2,
};

// if it's an MD21 chunk, all pointers are relative to the end of that chunk
#[derive(Debug, DekuRead)]
#[deku(magic = b"MD21")]
pub struct M2HeaderBlock {
    pub header: M2Header,
}

#[derive(Debug, DekuRead, Clone)]
#[deku(magic = b"MD20")]
pub struct M2Header {
    pub version: u32,
    name: WowCharArray,
    pub flags: u32,
    global_loops: WowArray<()>,
    sequences: WowArray<()>,
    sequence_lookups: WowArray<u16>,
    bones: WowArray<()>,
    key_bone_lookup: WowArray<u16>,
    vertices: WowArray<()>,
    pub num_skin_profiles: u32,
    colors: WowArray<()>,
    textures: WowArray<M2Texture>,
    texture_weights: WowArray<()>,
    texture_transforms: WowArray<()>,
    replacable_texture_lookup: WowArray<u8>,
    materials: WowArray<()>,
    bone_lookup_table: WowArray<u16>,
    texture_lookup_table: WowArray<u16>,
    texture_unit_lookup_table: WowArray<u16>,
    transparency_lookup_table: WowArray<u16>,
    texture_transforms_lookup_table: WowArray<u16>,
    pub bounding_box: AABBox,
    pub bounding_sphere_radius: f32,
    pub collision_box: AABBox,
    pub collision_sphere_radius: f32,
    collision_triangles: WowArray<u16>,
    collision_vertices: WowArray<Vec3>,
    collision_normals: WowArray<Vec3>,
    attachments: WowArray<()>,
    attachment_lookup_table: WowArray<u16>,
    events: WowArray<()>,
    lights: WowArray<()>,
    cameras: WowArray<()>,
    camera_lookup_table: WowArray<u16>,
    ribbon_emitters: WowArray<()>,
    particle_emitters: WowArray<()>,
    blend_map_overrides: WowArray<u16>,
}

#[derive(Debug, DekuRead)]
#[deku(magic = b"SKIN")]
pub struct SkinProfile {
    vertices: WowArray<u16>,
    indices: WowArray<u16>,
    bones: WowArray<[u8; 4]>,
    submeshes: WowArray<()>,
    batches: WowArray<()>,
    pub bone_count_max: u32,
}

#[wasm_bindgen]
#[derive(Debug)]
pub struct Skin {
    data: Vec<u8>,
    profile: SkinProfile,
}

#[wasm_bindgen]
impl Skin {
    pub fn new(data: Vec<u8>) -> Result<Skin, String> {
        let (_, profile) = SkinProfile::from_bytes((&data, 0))
            .map_err(|e| format!("{:?}", e))?;
        Ok(Skin {
            data,
            profile
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

#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct M2 {
    data: Vec<u8>,
    header: M2Header,
    texture_ids: Option<Txid>,
}

#[wasm_bindgen]
impl M2 {
    pub fn new(data: Vec<u8>) -> Result<M2, String> {
        let mut chunked_data = ChunkedData::new(&data);
        let header_chunk = chunked_data.next().ok_or("no header chunk".to_string())?;
        assert_eq!(&header_chunk.magic, b"MD21");
        let (_, header) = M2Header::from_bytes((&header_chunk.data, 0)).map_err(|e| format!("{:?}", e))?;
        let mut texture_ids = None;
        for chunk in chunked_data {
            match &chunk.magic {
                b"TXID" => {
                    let (_, txid) = Txid::from_bytes((&chunk.data, 0))
                        .map_err(|e| format!("{:?}", e))?;
                    texture_ids = Some(txid);
                },
                _ => {}, // ignore for now
            }
        }
        Ok(M2 {
            data,
            header,
            texture_ids,
        })
    }

    fn get_m2_data(&self) -> &[u8] {
        // M2 pointers are relative to the end of the MD21 block, which seems to
        // always be 16 bytes in
        &self.data[16..]
    }

    pub fn get_name(&self) -> Result<String, String> {
        self.header.name.to_string(self.get_m2_data())
            .map_err(|e| format!("{:?}", e))
    }

    pub fn get_vertex_stride() -> usize {
        // position + bone weights + bone indices + normal + texture coords
        12 + 4 + 4 + 12 + 2 * 8
    }

    pub fn get_vertex_data(&self) -> Result<Vec<u8>, String> {
        let vertex_data_start = self.header.vertices.offset as usize;
        let vertex_data_end = vertex_data_start + self.header.vertices.count as usize * M2::get_vertex_stride();
        Ok(self.get_m2_data()[vertex_data_start..vertex_data_end].to_vec())
    }

    pub fn get_vertex_count(&self) -> u32 {
        self.header.vertices.count
    }
}

#[derive(Debug, DekuRead, Clone)]
pub struct Txid {
    pub file_data_ids: u32,
}

#[derive(Debug, DekuRead)]
pub struct M2Vertex {
    pub position: Vec3,
    pub bone_weights: [u8; 4],
    pub bone_indices: [u8; 4],
    pub normal: Vec3,
    pub texture_coords: [Vec2; 2],
}

#[derive(Debug, DekuRead, Clone)]
pub struct M2Texture {
    pub type_: u32,
    pub flags: u32,
    pub filename: WowCharArray,
}

#[derive(Debug, DekuRead, Copy, Clone)]
pub struct Ldv1 {
    pub unk0: u16,
    pub lod_count: u16,
    pub unk2: f32,
    pub particle_bone_lod: [u8; 4],
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test() {
        let data = std::fs::read("D:/woof/wow uncasced/world/lordaeron/arathi/passivedoodads/farmhouses/arathifarmhouse01.m2").unwrap();
        let m2 = M2::new(data).unwrap();
        dbg!(m2.texture_ids);
    }
}
