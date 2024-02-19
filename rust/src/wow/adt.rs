use deku::prelude::*;
use deku::ctx::ByteSize;
use wasm_bindgen::prelude::*;

use super::common::{Chunk, ChunkedData, Vec3, AABBox};

#[wasm_bindgen(js_name = "WowAdt", getter_with_clone)]
#[derive(Debug, Clone)]
pub struct Adt {
    map_chunks: Vec<MapChunk>,
    doodads: Vec<Doodad>,
    height_tex_ids: Option<HeightTexIds>,
    diffuse_tex_ids: Option<DiffuseTexIds>,
    map_object_defs: Vec<WmoDefinition>,
    lod_doodads: Vec<Doodad>,
    lod_doodad_extents: Vec<LodExtent>,
    lod_map_object_defs: Vec<WmoDefinition>,
    lod_levels: Option<LodLevels>,
}

#[wasm_bindgen(js_class = "WowAdt")]
impl Adt {
    pub fn new(data: &[u8]) -> Result<Adt, String> {
        let mut chunked_data = ChunkedData::new(data);
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
            map_object_defs: vec![],
            lod_doodads: vec![],
            lod_doodad_extents: vec![],
            lod_map_object_defs: vec![],
            height_tex_ids: None,
            diffuse_tex_ids: None,
            lod_levels: None,
        })
    }

    pub fn get_texture_file_ids(&self) -> Vec<u32> {
        let mut ids = Vec::new();
        self.height_tex_ids.as_ref().map(|tex| ids.extend(&tex.file_data_ids));
        self.diffuse_tex_ids.as_ref().map(|tex| ids.extend(&tex.file_data_ids));
        ids.retain(|&id| id != 0);
        ids
    }

    pub fn get_model_file_ids(&self, lod_level: usize) -> Vec<u32> {
        assert!(lod_level <= 1);
        if lod_level == 0 {
            self.doodads.iter().map(|doodad| doodad.name_id).collect()
        } else {
            if let Some(lod_levels) = &self.lod_levels {
                let offset = lod_levels.m2_lod_offset[2] as usize;
                let length = lod_levels.m2_lod_length[2] as usize;
                self.lod_doodads[offset..offset+length].iter()
                    .map(|doodad| doodad.name_id)
                    .collect()
            } else {
                vec![]
            }
        }
    }

    pub fn get_doodads(&self, lod_level: usize) -> Vec<Doodad> {
        assert!(lod_level <= 1);
        if lod_level == 0 {
            self.doodads.clone()
        } else {
            if let Some(lod_levels) = &self.lod_levels {
                let offset = lod_levels.m2_lod_offset[2] as usize;
                let length = lod_levels.m2_lod_length[2] as usize;
                self.lod_doodads[offset..offset+length].to_vec()
            } else {
                vec![]
            }
        }
    }

    pub fn get_wmo_defs(&self, lod_level: usize) -> Vec<WmoDefinition> {
        assert!(lod_level <= 1);
        if lod_level == 0 {
            self.map_object_defs.clone()
        } else {
            if let Some(lod_levels) = &self.lod_levels {
                let offset = lod_levels.wmo_lod_offset[2] as usize;
                let length = lod_levels.wmo_lod_length[2] as usize;
                self.lod_map_object_defs[offset..offset+length].to_vec()
            } else {
                vec![]
            }
        }
    }

    pub fn append_lod_obj_adt(&mut self, data: &[u8]) -> Result<(), String> {
        let mut chunked_data = ChunkedData::new(data);
        let mut lod_wmos: Option<Vec<LodWmoDefinition>> = None;
        let mut lod_wmo_extents: Option<Vec<LodExtent>> = None;
        for (chunk, chunk_data) in &mut chunked_data {
            match &chunk.magic {
                b"DFLM" => self.lod_levels = Some(chunk.parse(chunk_data)?),
                b"DDLM" => self.lod_doodads = chunk.parse_array(chunk_data, 0x24)?,
                b"XDLM" => self.lod_doodad_extents = chunk.parse_array(chunk_data, 0x1c)?,
                b"DMLM" => lod_wmos = Some(chunk.parse_array(chunk_data, 0x28)?),
                b"XMLM" => lod_wmo_extents = Some(chunk.parse_array(chunk_data, 0x1c)?),
                _ => println!("skipping {}", std::str::from_utf8(&chunk.magic).unwrap()),
            }
        }
        assert_eq!(self.lod_doodads.len(), self.lod_doodad_extents.len());
        match (lod_wmos, lod_wmo_extents) {
            (Some(wmos), Some(wmo_extents)) => {
                assert_eq!(wmos.len(), wmo_extents.len());
                for i in 0..wmos.len() {
                    self.lod_map_object_defs.push(WmoDefinition {
                        name_id: wmos[i].name_id,
                        unique_id: wmos[i].unique_id,
                        position: wmos[i].position,
                        rotation: wmos[i].rotation,
                        flags: wmos[i].flags,
                        doodad_set: wmos[i].doodad_set,
                        name_set: wmos[i].name_set,
                        scale: wmos[i].scale,
                        extents: wmo_extents[i].extents,
                    });
                }
            },
            (None, None) => {},
            (_, _) => return Err("lod adt was missing some lod components".to_string()),
            _ => {},
        }
        Ok(())
    }

    pub fn append_obj_adt(&mut self, data: &[u8]) -> Result<(), String> {
        let mut chunked_data = ChunkedData::new(data);
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
                b"FDOM" => self.map_object_defs = chunk.parse_array(chunk_data, 0x40)?,
                _ => println!("skipping {}", std::str::from_utf8(&chunk.magic).unwrap()),
            }
        }
        Ok(())
    }

    pub fn append_tex_adt(&mut self, data: &[u8]) -> Result<(), String> {
        let mut chunked_data = ChunkedData::new(data);
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

    fn chunk_index_to_coords(index: usize) -> (f32, f32) {
        let mut x = (index as f32) % 17.0;
        let mut y = ((index as f32) / 17.0).floor();

        if x > 8.01 {
            y += 0.5;
            x -= 8.5;
        }
        (x, y)
    }

    // it's probably faster to just send the normals/colors as separate raw bufs but w/e
    fn get_vertex_buffer_and_extents(&self) -> (Vec<f32>, AABBox) {
        let mut result = Vec::with_capacity(256 * ADT_VBO_INFO.stride);
        let mut aabb = AABBox {
            min: Vec3 { x: f32::INFINITY, y: f32::INFINITY, z: f32::INFINITY },
            max: Vec3 { x: f32::NEG_INFINITY, y: f32::NEG_INFINITY, z: f32::NEG_INFINITY },
        };
        let unit_size: f32 = (1600.0 / 3.0) / 16.0 / 8.0;
        for mcnk in &self.map_chunks {
            for j in 0..(9*9 + 8*8) {
                result.push(j as f32); // add the chunk index

                // position
                let (x, y) = Adt::chunk_index_to_coords(j);
                let x_coord = mcnk.header.position.x - (y * unit_size); 
                let y_coord = mcnk.header.position.y - (x * unit_size);
                let z_coord = mcnk.header.position.z + mcnk.heightmap.heightmap[j];
                result.push(x_coord);
                result.push(y_coord);
                result.push(z_coord);

                // update aabb
                aabb.update(x_coord, y_coord, z_coord);

                // normals
                let normals = &mcnk.normals.normals[j*3..];
                result.push(normals[0] as f32 / 127.0);
                result.push(normals[1] as f32 / 127.0);
                result.push(normals[2] as f32 / 127.0);

                let vertex_colors = match mcnk.vertex_colors.as_ref() {
                    Some(mccv) => &mccv.vertex_colors[j*4..],
                    None => &[127, 127, 127, 127],
                };
                let mccv_norm = 0x7f as f32;
                result.push(vertex_colors[2] as f32 / mccv_norm); // r
                result.push(vertex_colors[1] as f32 / mccv_norm); // g
                result.push(vertex_colors[0] as f32 / mccv_norm); // b
                result.push(vertex_colors[3] as f32 / mccv_norm); // a

                let vertex_lighting = match mcnk.vertex_lighting.as_ref() {
                    Some(mclv) => &mclv.vertex_lighting[j*4..],
                    None => &[127, 127, 127, 127],
                };
                result.push(vertex_lighting[2] as f32 / 255.0); // r
                result.push(vertex_lighting[1] as f32 / 255.0); // g
                result.push(vertex_lighting[0] as f32 / 255.0); // b
                result.push(vertex_lighting[3] as f32 / 255.0); // a
            }
        }
        (result, aabb)
    }

    fn get_index_buffer_and_descriptors(&self, adt_has_big_alpha: bool, adt_has_height_texturing: bool) -> (Vec<u16>, Vec<ChunkDescriptor>) {
        let mut index_buffer = Vec::new();
        let mut descriptors = Vec::with_capacity(256);
        for (i, mcnk) in self.map_chunks.iter().enumerate() {
            let texture_layers = match (&mcnk.texture_layers, &self.diffuse_tex_ids) {
                (layers, Some(mdid)) => layers.iter()
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
            let alpha_texture = mcnk.build_alpha_texture(adt_has_big_alpha, adt_has_height_texturing);
            descriptors.push(ChunkDescriptor {
                texture_layers,
                index_offset,
                alpha_texture,
                index_count,
                debug_string: format!(
                    "big_alpha: {}, height_texturing: {}, layers: {:?}",
                    adt_has_big_alpha,
                    adt_has_height_texturing,
                    &mcnk.texture_layers
                ),
            });
        }
        (index_buffer, descriptors)
    }

    pub fn get_render_result(&self, adt_has_big_alpha: bool, adt_has_height_texturing: bool) -> AdtRenderResult {
        let (vertex_buffer, extents) = self.get_vertex_buffer_and_extents();
        let (index_buffer, chunks) = self.get_index_buffer_and_descriptors(adt_has_big_alpha, adt_has_height_texturing);
        AdtRenderResult {
            vertex_buffer: Some(vertex_buffer),
            index_buffer: Some(index_buffer),
            chunks,
            extents,
        }
    }

    pub fn get_vbo_info() -> AdtVBOInfo {
        ADT_VBO_INFO.clone()
    }
}

#[derive(Debug, DekuRead, Clone)]
pub struct LodLevels {
    pub m2_lod_offset: [u32; 3],
    pub m2_lod_length: [u32; 3],
    pub wmo_lod_offset: [u32; 3],
    pub wmo_lod_length: [u32; 3],
}

#[wasm_bindgen(js_name = "WowAdtRenderResult", getter_with_clone)]
pub struct AdtRenderResult {
    pub vertex_buffer: Option<Vec<f32>>,
    pub index_buffer: Option<Vec<u16>>,
    pub chunks: Vec<ChunkDescriptor>,
    pub extents: AABBox,
}

#[wasm_bindgen(js_class = "WowAdtRenderResult")]
impl AdtRenderResult {
    pub fn take_vertex_buffer(&mut self) -> Vec<f32> {
        self.vertex_buffer.take().expect("ADT RenderResult vertex buffer already taken")
    }

    pub fn take_index_buffer(&mut self) -> Vec<u16> {
        self.index_buffer.take().expect("ADT RenderResult index buffer already taken")
    }
}

#[wasm_bindgen(js_name = "WowAdtChunkDescriptor", getter_with_clone)]
#[derive(Debug, Clone)]
pub struct ChunkDescriptor {
    pub texture_layers: Vec<u32>,
    pub alpha_texture: Option<Vec<u8>>,
    pub index_offset: usize,
    pub index_count: usize,
    pub debug_string: String,
}

static SQUARE_INDICES_TRIANGLE: &[u16] = &[9, 0, 17, 9, 1, 0, 9, 18, 1, 9, 17, 18];

pub static ADT_VBO_INFO: AdtVBOInfo = AdtVBOInfo {
    stride:          (1 + 3 + 3 + 4 + 4) * 4,
    vertex_offset:   (1) * 4,
    normal_offset:   (1 + 3) * 4,
    color_offset:    (1 + 3 + 3) * 4,
    lighting_offset: (1 + 3 + 3 + 4) * 4,
};

#[wasm_bindgen(js_name = "WowAdtVBOInfo")]
#[derive(Clone)]
struct AdtVBOInfo {
    pub stride: usize,
    pub vertex_offset: usize,
    pub normal_offset: usize,
    pub color_offset: usize,
    pub lighting_offset: usize,
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
    pub size_liquid: u32,
    pub position: Vec3,
    pub mccv_offset: u32,
    pub mclv_offset: u32,
    pub unused: u32,
}

impl MapChunkHeader {
    pub fn is_hole(&self, x: usize, y: usize) -> bool {
        if (self.flags & 0x10000) > 0 {
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
    pub vertex_lighting: Option<VertexLighting>,
    pub texture_layers: Vec<MapChunkTextureLayer>,
    pub alpha_map: Option<AlphaMap>,
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
            vertex_lighting: None,
            alpha_map: None,
            texture_layers: vec![],
        })
    }

    // These two flags come from the WDT definition block flags
    pub fn build_alpha_texture(&self, adt_has_big_alpha: bool, adt_has_height_texturing: bool) -> Option<Vec<u8>> {
        let alpha_map = &self.alpha_map.as_ref()?.data;
        assert!(self.texture_layers.len() > 0);
        let mut result = vec![0; (64 * 4) * 64];
        for layer_idx in 0..self.texture_layers.len() {
            let layer = &self.texture_layers[layer_idx];
            let mut alpha_offset = layer.offset_in_mcal as usize;
            let mut off_o = layer_idx;
            let settings = MapChunkTextureLayerSettings::from(layer.settings);
            if !settings.use_alpha_map {
                for i in 0..4096 {
                    result[off_o + i*4] = 255;
                }
            } else if settings.alpha_map_compressed {
                let mut read_this_layer = 0;
                while read_this_layer < 4096 {
                    let fill = (alpha_map[alpha_offset] & 0x80) > 0;
                    let n = alpha_map[alpha_offset] & 0x7F;
                    alpha_offset += 1;

                    for _ in 0..n {
                        if read_this_layer >= 4096 {
                            break;
                        }
                        result[off_o] = alpha_map[alpha_offset];
                        read_this_layer += 1;
                        off_o += 4;

                        if !fill {
                            alpha_offset += 1;
                        }
                    }
                    if fill {
                        alpha_offset += 1;
                    }
                }
            } else {
                if adt_has_big_alpha || adt_has_height_texturing {
                    // uncompressed (4096)
                    for _ in 0..4096 {
                        result[off_o] = alpha_map[alpha_offset];
                        off_o += 4;
                        alpha_offset += 1;
                    }
                } else {
                    // uncompressed (2048)
                    for _ in 0..2048 {
                        result[off_o] = (alpha_map[alpha_offset] & 0x0f) * 17;
                        off_o += 4;
                        result[off_o] = ((alpha_map[alpha_offset] & 0xf0) >> 4) * 17;
                        off_o += 4;
                        alpha_offset += 1;
                    }
                }
            }
        }
        Some(result)
    }

    fn append_obj_chunk(&mut self, chunk: Chunk, chunk_data: &[u8]) -> Result<(), String> {
        let mut chunked_data = ChunkedData::new(&chunk_data);
        for (subchunk, subchunk_data) in &mut chunked_data {
            match &subchunk.magic {
                b"VCCM" => self.vertex_colors = Some(subchunk.parse(subchunk_data)?),
                b"VLCM" => self.vertex_lighting = Some(subchunk.parse(subchunk_data)?),
                _ => {},
            }
        }
        Ok(())
    }

    fn append_tex_chunk(&mut self, chunk: Chunk, chunk_data: &[u8]) -> Result<(), String> {
        let mut chunked_data = ChunkedData::new(&chunk_data);
        for (subchunk, subchunk_data) in &mut chunked_data {
            match &subchunk.magic {
                b"YLCM" => self.texture_layers = subchunk.parse_array(subchunk_data, 16)?,
                b"LACM" => self.alpha_map = subchunk.parse_with_byte_size(subchunk_data)?,
                _ => {},
            }
        }
        Ok(())
    }
}

#[wasm_bindgen(js_name = "WowAdtChunkTextureLayer")]
#[derive(Clone, DekuRead)]
pub struct MapChunkTextureLayer {
    pub texture_index: u32, // index into MDID?
    pub settings: u32,
    pub offset_in_mcal: u32,
    pub effect_id: u32,
}

impl std::fmt::Debug for MapChunkTextureLayer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MapChunkTextureLayer")
            .field("texture_index", &self.texture_index)
            .field("settings", &MapChunkTextureLayerSettings::from(self.settings))
            .field("offset_in_mcal", &self.offset_in_mcal)
            .field("effect_id", &self.effect_id)
            .finish()
    }
}

#[wasm_bindgen(js_class = "WowAdtChunkTextureLayer")]
impl MapChunkTextureLayer {
    pub fn get_settings(&self) -> MapChunkTextureLayerSettings {
        MapChunkTextureLayerSettings::from(self.settings)
    }
}

#[wasm_bindgen(js_name = "WowAdtChunkTextureLayerSettings")]
#[derive(Debug, Clone, Copy)]
pub struct MapChunkTextureLayerSettings {
    pub use_cube_map_reflection: bool,
    pub alpha_map_compressed: bool,
    pub use_alpha_map: bool,
    pub overbright: bool,
    pub animation_enabled: bool,
    pub animation_speed: u32,
    pub animation_rotation: u32,
}

impl From<u32> for MapChunkTextureLayerSettings {
    fn from(value: u32) -> Self {
        MapChunkTextureLayerSettings {
            animation_rotation:       value & 0b00000000111,
            animation_speed:          value & 0b00000111000,
            animation_enabled:       (value & 0b00001000000) > 0,
            overbright:              (value & 0b00010000000) > 0,
            use_alpha_map:           (value & 0b00100000000) > 0,
            alpha_map_compressed:    (value & 0b01000000000) > 0,
            use_cube_map_reflection: (value & 0b10000000000) > 0,
        }
    }
}

#[wasm_bindgen(js_name = "WowAdtChunkAlphaMap")]
#[derive(DekuRead, Debug, Clone)]
#[deku(ctx = "ByteSize(size): ByteSize")]
pub struct AlphaMap {
    #[deku(count = "size")]
    data: Vec<u8>
}

#[derive(Debug, Clone, DekuRead)]
pub struct VertexColors {
    pub vertex_colors: [u8; 4 * (9*9 + 8*8)],
}

#[derive(Debug, Clone, DekuRead)]
pub struct VertexLighting {
    pub vertex_lighting: [u8; 4 * (9*9 + 8*8)],
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

#[wasm_bindgen(js_name = "WowDoodad")]
#[derive(Debug, DekuRead, Clone)]
pub struct Doodad {
    pub name_id: u32,
    pub unique_id: u32,
    pub position: Vec3,
    pub rotation: Vec3,
    pub scale: u16,
    pub flags: u16
}

#[wasm_bindgen(js_name = "WowAdtWmoDefinition")]
#[derive(Debug, DekuRead, Clone)]
pub struct WmoDefinition {
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

#[derive(Debug, DekuRead, Clone)]
pub struct LodWmoDefinition {
    pub name_id: u32,
    pub unique_id: u32,
    pub position: Vec3,
    pub rotation: Vec3,
    pub flags: u16,
    pub doodad_set: u16,
    pub name_set: u16,
    pub scale: u16,
}

#[derive(Debug, DekuRead, Clone)]
pub struct LodExtent {
    pub extents: AABBox,
    pub radius: f32,
}

#[derive(DekuRead, Debug, Clone)]
pub struct HeightmapChunk {
    // the heightmap stores a row of 9 height values, then 8 LOD height values,
    // then back to 9, and so on
    pub heightmap: [f32; 9*9 + 8*8],
}

#[derive(DekuRead, Debug, Clone)]
pub struct NormalChunk {
    pub normals: [i8; 3 * (9*9 + 8*8)],
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
        let data = std::fs::read("../data/wow/world/maps/azeroth/azeroth_34_46.adt").unwrap();
        let mut adt = Adt::new(&data).unwrap();
        adt.append_lod_obj_adt(&std::fs::read("../data/wow/world/maps/azeroth/azeroth_34_46_obj1.adt").unwrap()).unwrap();
        dbg!(adt.lod_levels);
    }
}
