use deku::prelude::*;
use deku::ctx::ByteSize;
use wasm_bindgen::prelude::*;

use super::common::{Chunk, ChunkedData, Vec3, AABBox};

#[wasm_bindgen(js_name = "WowAdt")]
#[derive(Debug, Clone)]
pub struct Adt {
    map_chunks: Vec<MapChunk>,
    doodads: Vec<Doodad>,
}

#[wasm_bindgen(js_class = "WowAdt")]
impl Adt {
    pub fn new(data: Vec<u8>) -> Result<Adt, String> {
        let mut chunked_data = ChunkedData::new(&data);
        let mut map_chunks: Vec<MapChunk> = Vec::with_capacity(256);
        for (chunk, chunk_data) in &mut chunked_data {
            match &chunk.magic {
                b"KNCM" => map_chunks.push(MapChunk::new(chunk, &chunk_data)?),
                _ => println!("skipping {}", std::str::from_utf8(&chunk.magic).unwrap()),
            }
        }
        Ok(Adt {
            map_chunks,
            doodads: vec![],
        })
    }

    pub fn append_obj_adt(&mut self, data: Vec<u8>) -> Result<(), String> {
        let mut chunked_data = ChunkedData::new(&data);
        let mut map_chunk_idx = 0;
        for (chunk, chunk_data) in &mut chunked_data {
            match &chunk.magic {
                b"FDDM" => {
                    let mddf: DoodadChunk = chunk.parse_with_byte_size(chunk_data)?;
                    self.doodads = mddf.doodads;
                },
                b"KNCM" => {
                    self.map_chunks[map_chunk_idx].append_obj_chunk(chunk, chunk_data)?;
                    map_chunk_idx += 1;
                }
                _ => println!("skipping {}", std::str::from_utf8(&chunk.magic).unwrap()),
            }
        }
        Ok(())
    }

    pub fn append_tex_adt(&mut self, data: Vec<u8>) -> Result<(), String> {
        let mut chunked_data = ChunkedData::new(&data);
        let mut map_chunk_idx = 0;
        for (chunk, chunk_data) in &mut chunked_data {
            match &chunk.magic {
                b"KNCM" => {
                    self.map_chunks[map_chunk_idx].append_tex_chunk(chunk, chunk_data)?;
                    map_chunk_idx += 1;
                }
                _ => println!("skipping {}", std::str::from_utf8(&chunk.magic).unwrap()),
            }
        }
        Ok(())
    }
}

#[derive(DekuRead, Debug, Clone)]
pub struct MapChunkHeader {
    pub flags: u32,
    pub index_x: u32,
    pub index_y: u32,
    pub n_layers: u32,
    pub n_doodad_refs: u32,
    pub holes_high_res: u64,
    pub ofs_layer: u32,
    pub ofs_refs: u32,
    pub ofs_alpha: u32,
    pub size_alpha: u32,
    pub ofs_shadow: u32,
    pub size_shadow: u32,
    pub area_id: u32,
    pub n_map_obj_refs: u32,
    pub holes_low_res: u16,
    pub unknown_but_used: u16,
    pub low_quality_texture_map: [u16; 8],
    pub no_effect_doodad: [u8; 8],
    pub ofs_snd_emitters: u32,
    pub n_snd_emitters: u32,
    pub ofs_liquid: u32,
    #[deku(pad_bytes_after = "0x12")]
    pub size_liquid: u32,
}

#[derive(Debug, Clone)]
pub struct MapChunk {
    pub header: MapChunkHeader,
    pub heightmap: HeightmapChunk,
    pub normals: NormalChunk,
    pub shadows: Option<ShadowMapChunk>,
}

impl MapChunk {
    pub fn new(chunk: Chunk, chunk_data: &[u8]) -> Result<Self, String> {
        let header = chunk.parse(chunk_data)?;

        let mut mcvt: Option<HeightmapChunk> = None;
        let mut mcnr: Option<NormalChunk> = None;
        let mut mcsh: Option<ShadowMapChunk> = None;
        let mut chunked_data = ChunkedData::new(&chunk_data[0x80..]);
        for (subchunk, subchunk_data) in &mut chunked_data {
            match &subchunk.magic {
                b"TVCM" => mcvt = Some(subchunk.parse(subchunk_data)?),
                b"RNCM" => mcnr = Some(subchunk.parse(subchunk_data)?),
                b"HSMC" => mcsh = Some(subchunk.parse(subchunk_data)?),
                //_ => println!("skipping subchunk {}", subchunk.magic_str()),
                _ => {},
            }
        }

        Ok(MapChunk {
            header,
            normals: mcnr.ok_or("MapChunk had no MCNR chunk".to_string())?,
            heightmap: mcvt.ok_or("MapChunk had no MCVT chunk".to_string())?,
            shadows: mcsh,
        })
    }

    fn append_obj_chunk(&mut self, chunk: Chunk, chunk_data: &[u8]) -> Result<(), String> {
        // TODO
        Ok(())
    }

    fn append_tex_chunk(&mut self, chunk: Chunk, chunk_data: &[u8]) -> Result<(), String> {
        // TODO
        Ok(())
    }
}

#[derive(Debug, DekuRead)]
#[deku(ctx = "ByteSize(size): ByteSize")]
pub struct DoodadChunk {
    #[deku(count = "size / 0x24")]
    doodads: Vec<Doodad>
}

#[derive(Debug, DekuRead, Clone)]
pub struct Doodad {
    pub name_id: u32,
    pub unique_id: u32,
    pub position: Vec3,
    pub rotation: Vec3,
    pub scale: u16,
}

#[derive(Debug, DekuRead)]
#[deku(ctx = "ByteSize(size): ByteSize")]
struct ModfChunk {
    #[deku(count = "size / 0x40")]
    modfs: Vec<Modf>,
}

#[derive(Debug, DekuRead)]
pub struct Modf {
    pub name_id: u32,
    pub unique_id: u32,
    pub position: Vec3,
    pub rotation: Vec3,
    pub extents: AABBox,
    pub flags: u16,
    pub doodad_set: u16,
    pub name_set: u16,
    pub scale: u16,
}

#[derive(DekuRead, Debug, Clone)]
pub struct HeightmapChunk {
    // the heightmap stores a row of 9 height values, then 8 LOD height values,
    // then back to 9, and so on
    pub heightmap: [f32; 9*9 + 8*8],
}

#[derive(DekuRead, Debug, Clone)]
pub struct NormalChunk {
    pub normals: [u8; 3 * (9*9 + 8*8)],
}

#[derive(DekuRead, Debug, Clone)]
pub struct ShadowMapChunk {
    pub shadow_map: [u64; 64],
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test() {
        let data = std::fs::read("D:/woof/wow uncasced/world/maps/tanarisinstance/tanarisinstance_29_27.adt").unwrap();
        let adt = Adt::new(data);
    }
}
