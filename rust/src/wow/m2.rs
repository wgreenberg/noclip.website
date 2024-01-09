use deku::prelude::*;
use deku::ctx::ByteSize;
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

#[wasm_bindgen(js_name = "WowM2")]
#[derive(Debug, Clone)]
pub struct M2 {
    data: Vec<u8>,
    header: M2Header,
    texture_ids: Txid,
    skin_ids: Sfid,
}

#[wasm_bindgen(js_class = "WowM2")]
impl M2 {
    pub fn new(data: Vec<u8>) -> Result<M2, String> {
        let mut chunked_data = ChunkedData::new(&data);
        let (header_chunk, chunk_data) = chunked_data.next()
            .ok_or("no header chunk".to_string())?;
        assert_eq!(&header_chunk.magic, b"MD21");
        let (_, header) = M2Header::from_bytes((chunk_data, 0))
            .map_err(|e| format!("{:?}", e))?;

        let mut txid = None;
        let mut sfid = None;
        for (chunk, chunk_data) in &mut chunked_data {
            match &chunk.magic {
                b"TXID" => txid = Some(chunk.parse(&chunk_data)?),
                b"SFID" => sfid = Some(chunk.parse(&chunk_data)?),
                _ => {},
            }
        }

        Ok(M2 {
            data,
            header,
            texture_ids: txid.ok_or("M2 didn't have TXID chunk!".to_string())?,
            skin_ids: sfid.ok_or("M2 didn't have SKID chunk!".to_string())?,
        })
    }

    fn get_m2_data(&self) -> &[u8] {
        // M2 pointers are relative to the end of the MD21 block, which seems to
        // always be 16 bytes in
        &self.data[8..]
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
        let vertex_data_size = self.header.vertices.count as usize * M2::get_vertex_stride();
        let vertex_data_end = vertex_data_start + vertex_data_size;
        Ok(self.get_m2_data()[vertex_data_start..vertex_data_end].to_vec())
    }

    pub fn get_texture_ids(&self) -> Vec<u32> { self.texture_ids.file_data_ids.clone() }
    pub fn get_skin_ids(&self) -> Vec<u32> { self.skin_ids.skin_file_ids.clone() }
    pub fn get_texture_lookup_table(&self) -> Result<Vec<u16>, String> {
        self.header.texture_lookup_table.to_vec(self.get_m2_data())
            .map_err(|e| format!("{:?}", e))
    }
}

#[derive(Debug, DekuRead, Clone)]
#[deku(ctx = "ByteSize(size): ByteSize")]
pub struct Txid {
    #[deku(count = "size / 4")]
    pub file_data_ids: Vec<u32>,
}

#[derive(Debug, DekuRead, Clone)]
#[deku(ctx = "ByteSize(size): ByteSize")]
pub struct Sfid {
    #[deku(count = "size / 4")]
    skin_file_ids: Vec<u32>,
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
