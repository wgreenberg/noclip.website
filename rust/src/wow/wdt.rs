use deku::{prelude::*, ctx::ByteSize};
use wasm_bindgen::prelude::*;

use super::common::ChunkedData;

#[wasm_bindgen(js_name = "WowWdt")]
pub struct Wdt {
    data: Vec<u8>,
    pub header: Mphd,
    area_infos: Vec<AreaInfo>,
    map_filedata_ids: Vec<MapFileDataIDs>,
}

#[wasm_bindgen(js_class = "WowWdt")]
impl Wdt {
    pub fn new(data: Vec<u8>) -> Result<Wdt, String> {
        let mut chunked_data = ChunkedData::new(&data);
        let mut header: Option<Mphd> = None;
        let mut area_infos: Vec<AreaInfo> = Vec::with_capacity(4096);
        let mut map_filedata_ids: Vec<MapFileDataIDs> = Vec::with_capacity(4096);
        for (chunk, chunk_data) in &mut chunked_data {
            match &chunk.magic {
                b"NIAM" => {
                    let size = 2 * 4;
                    for i in 0..4096 {
                        area_infos.push(chunk.parse(&chunk_data[i*size..(i+1)*size])?)
                    }
                },
                b"DIAM" => {
                    let size = 8 * 4;
                    for i in 0..4096 {
                        map_filedata_ids.push(chunk.parse(&chunk_data[i*size..(i+1)*size])?)
                    }
                },
                b"DHPM" => header = Some(chunk.parse(&chunk_data)?),
                _ => println!("skipping {}", chunk.magic_str()),
            }
        }
        if area_infos.is_empty() || map_filedata_ids.is_empty() {
            return Err("WDT file has no map filedata!".to_string());
        }
        Ok(Wdt {
            data,
            header: header.ok_or("WDT has no header chunk!".to_string())?,
            area_infos,
            map_filedata_ids,
        })
    }

    pub fn get_loaded_map_data(&self) -> Vec<MapFileDataIDs> {
        let mut result = Vec::new();
        for i in 0..self.area_infos.len() {
            if self.area_infos[i].flags != 2 {
                result.push(self.map_filedata_ids[i].clone());
            }
        }
        result
    }
}

#[wasm_bindgen(js_name = "WowAreaInfo")]
#[derive(Debug, DekuRead, Clone)]
pub struct AreaInfo {
    pub flags: u32,
    pub async_id: u32,
}

#[wasm_bindgen(js_class = "WowAreaInfo")]
impl AreaInfo {
    pub fn is_all_water(&self) -> bool {
        (self.flags & 0b01) == 1
    }

    pub fn is_loaded(&self) -> bool {
        (self.flags & 0b10) == 1
    }
}

#[wasm_bindgen(js_name = "WowMphd")]
#[derive(Debug, DekuRead, Clone, Copy)]
pub struct Mphd {
    pub flags: u32,
    pub lgt_file_data_id: u32,
    pub occ_file_data_id: u32,
    pub fogs_file_data_id: u32,
    pub mpv_file_data_id: u32,
    pub tex_file_data_id: u32,
    pub wdl_file_data_id: u32,
    pub pd4_file_data_id: u32,
}

#[wasm_bindgen(js_name = "WowMapFileDataIDs")]
#[derive(DekuRead, Debug, Clone)]
pub struct MapFileDataIDs {
    pub root_adt: u32, // reference to fdid of mapname_xx_yy.adt
    pub obj0_adt: u32, // reference to fdid of mapname_xx_yy_obj0.adt
    pub obj1_adt: u32, // reference to fdid of mapname_xx_yy_obj1.adt
    pub tex0_adt: u32, // reference to fdid of mapname_xx_yy_tex0.adt
    pub lod_adt: u32,  // reference to fdid of mapname_xx_yy_lod.adt
    pub map_texture: u32, // reference to fdid of mapname_xx_yy.blp
    pub map_texture_n: u32, // reference to fdid of mapname_xx_yy_n.blp
    pub minimap_texture: u32, // reference to fdid of mapxx_yy.blp
}
