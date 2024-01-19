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
        for (chunk, chunk_data) in &mut chunked_data {
            match &chunk.magic {
                b"TMOM" => momt = Some(chunk.parse_array(chunk_data, 0x40)?),
                b"IGOM" => mogi = Some(chunk.parse_array(chunk_data, 0x20)?),
                b"DDOM" => modd = Some(chunk.parse_array(chunk_data, 40)?),
                b"GOFM" => mfog = Some(chunk.parse_array(chunk_data, 48)?),
                b"IDOM" => modi = Some(chunk.parse_array(chunk_data, 4)?),
                b"DIFG" => gfid = Some(chunk.parse_array(chunk_data, 4)?),
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
        })
    }
}

#[wasm_bindgen(js_name = "WowWmoGroup", getter_with_clone)]
#[derive(Debug, Clone)]
pub struct WmoGroup {
    pub header: WmoGroupHeader,
    pub material_info: Vec<MaterialInfo>,
    pub indices: Vec<u8>,
    pub vertices: Vec<u8>,
    pub normals: Vec<u8>,
    pub uvs: Vec<u8>,
    pub batches: Vec<MaterialBatch>,
    pub doodad_refs: Vec<u16>,
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
        let mut uvs: Option<Vec<u8>> = None;
        let mut batches: Option<Vec<MaterialBatch>> = None;
        let mut doodad_refs: Option<Vec<u16>> = None;
        let mut chunked_data = ChunkedData::new(&data[0x58..]);
        for (chunk, chunk_data) in &mut chunked_data {
            match &chunk.magic {
                b"YPOM" => mopy = Some(chunk.parse_array(chunk_data, 2)?),
                b"IVOM" => indices = Some(chunk_data.to_vec()),
                b"TVOM" => vertices = Some(chunk_data.to_vec()),
                b"RNOM" => normals = Some(chunk_data.to_vec()),
                b"VTOM" => uvs = Some(chunk_data.to_vec()),
                b"ABOM" => batches = Some(chunk.parse_array(chunk_data, 24)?),
                b"RDOM" => doodad_refs = Some(chunk.parse_array(chunk_data, 2)?),
                _ => println!("skipping {}", chunk.magic_str()),
            }
        }

        Ok(WmoGroup {
            header,
            material_info: mopy.ok_or("WMO group didn't have MOPY chunk")?,
            indices: indices.ok_or("WMO group didn't have indices")?,
            vertices: vertices.ok_or("WMO group didn't have vertices")?,
            normals: normals.ok_or("WMO group didn't have normals")?,
            uvs: uvs.ok_or("WMO group didn't have uvs")?,
            batches: batches.unwrap_or(vec![]),
            doodad_refs: doodad_refs.unwrap_or(vec![]),
        })
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test() {
        let wmoData = std::fs::read("C:/Users/ifnsp/dev/noclip.website/data/wow/world/wmo/lorderon/collidabledoodads/plaguelandbridge/plaguelandsbridge_000.wmo").unwrap();
        dbg!(WmoGroup::new(wmoData));
    }
}
