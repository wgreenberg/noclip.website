use deku::{prelude::*, bitvec::BitView};
use deku::ctx::ByteSize;
use wasm_bindgen::prelude::*;

use super::common::{Chunk, ChunkedData, Vec3, AABBox};

#[wasm_bindgen(js_name = "WowAdt")]
#[derive(Debug, Clone)]
pub struct Adt {
    map_chunks: Vec<MapChunk>,
    doodads: Vec<Doodad>,
    height_tex_ids: Option<HeightTexIds>,
    diffuse_tex_ids: Option<DiffuseTexIds>,
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
            height_tex_ids: None,
            diffuse_tex_ids: None,
        })
    }

    pub fn get_texture_file_ids(&self) -> Vec<u32> {
        let mut ids = Vec::new();
        self.height_tex_ids.as_ref().map(|tex| ids.extend(&tex.file_data_ids));
        self.diffuse_tex_ids.as_ref().map(|tex| ids.extend(&tex.file_data_ids));
        ids.retain(|&id| id != 0);
        ids
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
                b"DIHM" => self.height_tex_ids = Some(chunk.parse_with_byte_size(chunk_data)?),
                b"DIDM" => self.diffuse_tex_ids = Some(chunk.parse_with_byte_size(chunk_data)?),
                _ => println!("skipping {}", std::str::from_utf8(&chunk.magic).unwrap()),
            }
        }
        Ok(())
    }

    // it's probably faster to just send the normals/colors as separate raw bufs but w/e
    fn get_vertex_buffer(&self) -> Vec<f32> {
        let mut result = Vec::with_capacity(256 * ADT_VBO_INFO.stride);
        let unit_size: f32 = (1600.0 / 3.0) / 16.0 / 8.0;
        for mcnk in &self.map_chunks {
            for j in 0..(9*9 + 8*8) {
                let mut iX = (j as f32) % 17.0;
                let mut iY = ((j as f32) / 17.0).floor();

                if iX > 8.01 {
                    iY += 0.5;
                    iX -= 8.5;
                }

                // position
                result.push(mcnk.header.position.x - (iY * unit_size));
                result.push(mcnk.header.position.y - (iX * unit_size));
                result.push(mcnk.header.position.z + mcnk.heightmap.heightmap[j]);

                // normals
                let normals = &mcnk.normals.normals[j*3..];
                result.push(normals[0] as f32 / 127.0);
                result.push(normals[1] as f32 / 127.0);
                result.push(normals[2] as f32 / 127.0);

                let vertex_colors = match mcnk.vertex_colors.as_ref() {
                    Some(mccv) => &mccv.vertex_colors[j*4..],
                    None => &[127, 127, 127, 127],
                };
                result.push(vertex_colors[2] as f32 / 255.0); // r
                result.push(vertex_colors[1] as f32 / 255.0); // g
                result.push(vertex_colors[0] as f32 / 255.0); // b
                result.push(vertex_colors[3] as f32 / 255.0); // a
            }
        }
        result
    }

    fn get_index_buffer_and_descriptors(&self) -> (Vec<u16>, Vec<ChunkDescriptor>) {
        let mut index_buffer = Vec::new();
        let mut descriptors = Vec::with_capacity(256);
        for (i, mcnk) in self.map_chunks.iter().enumerate() {
            let texture_layers = match (&mcnk.texture_layers, &self.diffuse_tex_ids) {
                (Some(layers), Some(mdid)) => layers.layers.iter()
                    .map(|layer| mdid.file_data_ids[layer.texture_index as usize])
                    .collect(),
                _ => vec![],
            };
            let mut index_count = 0;
            let index_offset = index_buffer.len();
            for y in 0..8 {
                for x in 0..8 {
                    if mcnk.header.is_hole(x, y) {
                        continue;
                    }
                    for k in 0..12 {
                        let offset = (i as u16) * (9*9 + 8*8);
                        index_buffer.push(offset + SQUARE_INDICES_TRIANGLE[k] + 17 * (y as u16) + (x as u16));
                        index_count += 1;
                    }
                }
            }
            descriptors.push(ChunkDescriptor {
                texture_layers,
                index_offset,
                index_count,
            });
        }
        (index_buffer, descriptors)
    }

    pub fn get_render_result(&self) -> AdtRenderResult {
        let vertex_buffer = self.get_vertex_buffer();
        let (index_buffer, chunks) = self.get_index_buffer_and_descriptors();
        AdtRenderResult {
            vertex_buffer,
            index_buffer,
            chunks,
        }
    }

    pub fn get_vbo_info() -> AdtVBOInfo {
        ADT_VBO_INFO.clone()
    }
}

#[wasm_bindgen(js_name = "WowAdtRenderResult", getter_with_clone)]
pub struct AdtRenderResult {
    pub vertex_buffer: Vec<f32>,
    pub index_buffer: Vec<u16>,
    pub chunks: Vec<ChunkDescriptor>,
}

#[wasm_bindgen(js_name = "WowAdtChunkDescriptor", getter_with_clone)]
#[derive(Debug, Clone)]
pub struct ChunkDescriptor {
    pub texture_layers: Vec<u32>,
    pub index_offset: usize,
    pub index_count: usize,
}

static SQUARE_INDICES_TRIANGLE: &[u16] = &[9, 0, 17, 9, 1, 0, 9, 18, 1, 9, 17, 18];

pub static ADT_VBO_INFO: AdtVBOInfo = AdtVBOInfo {
    stride: (3 + 3 + 4) * 4,
    vertex_offset: 0,
    normal_offset: 3 * 4,
    color_offset: 6 * 4,
};

#[wasm_bindgen(js_name = "WowAdtVBOInfo")]
#[derive(Clone)]
struct AdtVBOInfo {
    pub stride: usize,
    pub vertex_offset: usize,
    pub normal_offset: usize,
    pub color_offset: usize,
}

#[derive(DekuRead, Debug, Clone)]
pub struct MapChunkFlags {
    #[deku(bits = 1)] pub has_mcsh: bool,
    #[deku(bits = 1)] pub impass: bool,
    #[deku(bits = 1)] pub lq_river: bool,
    #[deku(bits = 1)] pub lq_ocean: bool,
    #[deku(bits = 1)] pub lq_magma: bool,
    #[deku(bits = 1)] pub lq_slime: bool,
    #[deku(bits = 1)] pub has_mccv: bool,
    #[deku(bits = 1, pad_bits_after = "7")] pub unknown: bool,
    #[deku(bits = 1)] pub do_not_fix_alpha_map: bool,
    #[deku(bits = 1, pad_bits_after = "15")] pub high_res_holes: bool,
}

#[derive(DekuRead, Debug, Clone)]
pub struct MapChunkHeader {
    pub flags: MapChunkFlags,
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
    pub size_liquid: u32,
    pub position: Vec3,
    pub mccv_offset: u32,
    pub mclv_offset: u32,
    pub unused: u32,
}

impl MapChunkHeader {
    pub fn is_hole(&self, x: usize, y: usize) -> bool {
        if self.flags.high_res_holes {
            let hole_bytes = self.holes_high_res.to_le_bytes();
            ((hole_bytes[y] >> x) & 1) > 0
        } else {
            let holetab_h: [u16; 4] = [0x1111, 0x2222, 0x4444, 0x8888];
            let holetab_v: [u16; 4] = [0x000F, 0x00F0, 0x0F00, 0xF000];
            let i = x >> 1;
            let j = y >> 1;
            (self.holes_low_res & holetab_h[i] & holetab_v[j]) != 0
        }
    }
}

#[derive(Debug, Clone)]
pub struct MapChunk {
    pub header: MapChunkHeader,
    pub heightmap: HeightmapChunk,
    pub normals: NormalChunk,
    pub shadows: Option<ShadowMapChunk>,
    pub vertex_colors: Option<VertexColors>,
    pub texture_layers: Option<MapChunkTextureLayers>,
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

            // these will be appended in separate ADT files
            vertex_colors: None,
            texture_layers: None,
        })
    }

    fn append_obj_chunk(&mut self, chunk: Chunk, chunk_data: &[u8]) -> Result<(), String> {
        let mut chunked_data = ChunkedData::new(&chunk_data);
        let mut mccv: Option<VertexColors> = None;
        for (subchunk, subchunk_data) in &mut chunked_data {
            match &subchunk.magic {
                b"VCCM" => mccv = Some(subchunk.parse(subchunk_data)?),
                _ => {},
            }
        }
        self.vertex_colors = mccv;
        Ok(())
    }

    fn append_tex_chunk(&mut self, chunk: Chunk, chunk_data: &[u8]) -> Result<(), String> {
        let mut chunked_data = ChunkedData::new(&chunk_data);
        let mut mcly: Option<MapChunkTextureLayers> = None;
        for (subchunk, subchunk_data) in &mut chunked_data {
            match &subchunk.magic {
                b"YLCM" => mcly = Some(subchunk.parse_with_byte_size(subchunk_data)?),
                _ => {},
            }
        }
        self.texture_layers = mcly;
        Ok(())
    }
}

#[derive(Debug, Clone, DekuRead)]
#[deku(ctx = "ByteSize(size): ByteSize")]
pub struct MapChunkTextureLayers {
    #[deku(count = "size / 16")]
    layers: Vec<MapChunkTextureLayer>,
}

#[wasm_bindgen(js_name = "WowAdtChunkTextureLayer")]
#[derive(Debug, Clone, DekuRead)]
pub struct MapChunkTextureLayer {
    pub texture_index: u32, // index into MDID?
    pub flags: u32,
    pub offset_in_mcal: u32,
    pub effect_id: u32,
}

#[derive(Debug, Clone, DekuRead)]
pub struct VertexColors {
    pub vertex_colors: [u8; 4 * (9*9 + 8*8)],
}

#[derive(Debug, DekuRead)]
#[deku(ctx = "ByteSize(size): ByteSize")]
pub struct DoodadChunk {
    #[deku(count = "size / 0x24")]
    doodads: Vec<Doodad>
}

#[derive(Debug, Clone, DekuRead)]
#[deku(ctx = "ByteSize(size): ByteSize")]
pub struct DiffuseTexIds {
    #[deku(count = "size / 4")]
    pub file_data_ids: Vec<u32>
}

#[derive(Debug, Clone, DekuRead)]
#[deku(ctx = "ByteSize(size): ByteSize")]
pub struct HeightTexIds {
    #[deku(count = "size / 4")]
    pub file_data_ids: Vec<u32>
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
        //let adt = Adt::new(data);
    }
}
