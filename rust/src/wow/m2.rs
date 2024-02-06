use deku::prelude::*;
use deku::ctx::ByteSize;
use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;
use crate::wow::common::ChunkedData;
use crate::wow::animation::*;

use super::common::{
    WowArray,
    WowCharArray,
    AABBox,
    Vec3,
    Vec2, Quat,
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
    global_sequence_durations: WowArray<u32>,
    sequences: WowArray<M2Sequence>,
    sequence_lookups: WowArray<u16>,
    bones: WowArray<M2CompBoneUnallocated>,
    key_bone_lookup: WowArray<u16>,
    vertices: WowArray<()>,
    pub num_skin_profiles: u32,
    colors: WowArray<M2ColorUnallocated>,
    textures: WowArray<M2Texture>,
    texture_weights: WowArray<M2TrackUnallocated<u16>>,
    texture_transforms: WowArray<M2TextureTransformUnallocated>,
    replacable_texture_lookup: WowArray<u8>,
    materials: WowArray<M2Material>,
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

#[wasm_bindgen(js_name = "WowM2", getter_with_clone)]
#[derive(Debug, Clone)]
pub struct M2 {
    data: Vec<u8>,
    header: M2Header,
    pub texture_ids: Vec<u32>,
    pub skin_ids: Vec<u32>,
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

        let mut txid: Option<Vec<u32>> = None;
        let mut sfid: Option<Vec<u32>> = None;
        for (chunk, chunk_data) in &mut chunked_data {
            match &chunk.magic {
                b"TXID" => txid = Some(chunk.parse_array(&chunk_data, 4)?),
                b"SFID" => sfid = Some(chunk.parse_array(&chunk_data, 4)?),
                _ => {},
            }
        }

        Ok(M2 {
            data,
            header,
            texture_ids: txid.unwrap_or(vec![]),
            skin_ids: sfid.ok_or("M2 didn't have SKID chunk!".to_string())?,
        })
    }

    pub fn get_bounding_box(&self) -> AABBox {
        self.header.bounding_box.clone()
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

    pub fn get_materials(&self) -> Result<Vec<M2Material>, String> {
        self.header.materials.to_vec(self.get_m2_data())
            .map_err(|e| format!("{:?}", e))
    }

    fn get_vertex_colors(&self) -> Result<Vec<M2Color>, String> {
        let colors = self.header.colors.to_vec(self.get_m2_data())
            .map_err(|e| format!("{:?}", e))?;

        let mut result = Vec::with_capacity(colors.len());
        for c in colors {
            result.push(M2Color {
                color: c.color.to_allocated(self.get_m2_data()).map_err(|e| format!("{:?}", e))?,
                alpha: c.alpha.to_allocated(self.get_m2_data()).map_err(|e| format!("{:?}", e))?,
            });
        }
        Ok(result)
    }

    fn get_texture_transforms(&self) -> Result<Vec<M2TextureTransform>, String> {
        let texture_transforms = self.header.texture_transforms.to_vec(self.get_m2_data())
            .map_err(|e| format!("{:?}", e))?;

        let mut result = Vec::with_capacity(texture_transforms.len());
        for tex in texture_transforms {
            result.push(M2TextureTransform {
                translation: tex.translation.to_allocated(self.get_m2_data()).map_err(|e| format!("{:?}", e))?,
                rotation: tex.rotation.to_allocated(self.get_m2_data()).map_err(|e| format!("{:?}", e))?,
                scaling: tex.scaling.to_allocated(self.get_m2_data()).map_err(|e| format!("{:?}", e))?,
            });
        }
        Ok(result)
    }

    fn get_bones(&self) -> Result<Vec<M2CompBone>, String> {
        let bones = self.header.bones.to_vec(self.get_m2_data())
            .map_err(|e| format!("{:?}", e))?;

        let mut result = Vec::with_capacity(bones.len());
        for bone in bones {
            result.push(M2CompBone {
                translation: bone.translation.to_allocated(self.get_m2_data()).map_err(|e| format!("{:?}", e))?,
                rotation: bone.rotation.to_allocated(self.get_m2_data()).map_err(|e| format!("{:?}", e))?,
                scaling: bone.scaling.to_allocated(self.get_m2_data()).map_err(|e| format!("{:?}", e))?,
                key_bone_id: bone.key_bone_id,
                flags: bone.flags,
                parent_bone: bone.parent_bone,
                submesh_id: bone.submesh_id,
                pivot: bone.pivot,
            });
        }
        Ok(result)
    }

    fn get_texture_weights(&self) -> Result<Vec<M2TextureWeight>, String> {
        let weights = self.header.texture_weights.to_vec(self.get_m2_data())
            .map_err(|e| format!("{:?}", e))?;

        let mut result = Vec::with_capacity(weights.len());
        for weight in weights {
            result.push(M2TextureWeight {
                weights: weight.to_allocated(self.get_m2_data()).map_err(|e| format!("{:?}", e))?,
            });
        }
        Ok(result)
    }

    pub fn get_animation_manager(&self) -> Result<AnimationManager, String> {
        Ok(AnimationManager::new(
            self.header.global_sequence_durations.to_vec(self.get_m2_data()).map_err(|e| format!("{:?}", e))?,
            self.header.sequences.to_vec(self.get_m2_data()).map_err(|e| format!("{:?}", e))?,
            self.get_texture_weights()?,
            self.get_texture_transforms()?,
            self.get_vertex_colors()?,
            self.get_bones()?
        ))
    }

    pub fn get_vertex_stride() -> usize {
        // position + bone weights + bone indices + normal + texture coords
        12 + 4 + 4 + 12 + 2 * 8
    }

    pub unsafe fn get_vertex_data(&self) -> Result<Vec<u8>, String> {
        let vertex_data_start = self.header.vertices.offset as usize;
        let vertex_data_size = self.header.vertices.count as usize * M2::get_vertex_stride();
        let vertex_data_end = vertex_data_start + vertex_data_size;
        Ok(self.get_m2_data()[vertex_data_start..vertex_data_end].to_vec())
    }

    pub fn get_texture_lookup_table(&self) -> Result<Vec<u16>, String> {
        self.header.texture_lookup_table.to_vec(self.get_m2_data())
            .map_err(|e| format!("{:?}", e))
    }

    pub fn get_texture_transforms_lookup_table(&self) -> Result<Vec<u16>, String> {
        self.header.texture_transforms_lookup_table.to_vec(self.get_m2_data())
            .map_err(|e| format!("{:?}", e))
    }

    pub fn get_transparency_lookup_table(&self) -> Result<Vec<u16>, String> {
        self.header.transparency_lookup_table.to_vec(self.get_m2_data())
            .map_err(|e| format!("{:?}", e))
    }
}

#[wasm_bindgen(js_name = "WowM2Material")]
#[derive(DekuRead, Debug, Clone)]
pub struct M2Material {
    pub flags: u16,
    pub blending_mode: M2BlendingMode,
}

#[wasm_bindgen(js_name = "WowM2BlendingMode")]
#[derive(DekuRead, Debug, Copy, Clone)]
#[deku(type = "u16")]
pub enum M2BlendingMode {
    Opaque = 0,
    AlphaKey = 1,
    Alpha = 2,
    NoAlphaAdd = 3, // unused
    Add = 4,
    Mod = 5,
    Mod2x = 6,
    BlendAdd = 7, // unused
}

#[wasm_bindgen(js_name = "WowM2MaterialFlags")]
pub struct M2MaterialFlags {
    pub unlit: bool,
    pub unfogged: bool,
    pub two_sided: bool,
    pub depth_tested: bool,
    pub depth_write: bool,
}

#[wasm_bindgen(js_class = "WowM2MaterialFlags")]
impl M2MaterialFlags {
    pub fn new(x: u16) -> Self {
        Self {
            unlit:        (x & 0x01) > 0,
            unfogged:     (x & 0x02) > 0,
            two_sided:    (x & 0x04) > 0,
            depth_tested: (x & 0x08) == 0,
            depth_write:  (x & 0x10) == 0,
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test() {
        //let data = std::fs::read("../data/wow/world/critter/birds/bird02.m2").unwrap();
        //let data = std::fs::read("../data/wow/world/generic/nightelf/passive doodads/magicalimplements/nemagicimplement06.m2").unwrap();
        //let data = std::fs::read("../data/wow/world/generic/passivedoodads/particleemitters/druidwisp01.m2").unwrap();
        let data = std::fs::read("../data/wow/world/kalimdor/barrens/passivedoodads/waterwheel/orc_waterwheel.m2").unwrap();
        //let data = std::fs::read("../data/wow/world/kalimdor/kalidar/passivedoodads/kalidartrees/kalidartree01.m2").unwrap();
        let m2 = M2::new(data).unwrap();
        let mut animation_manager = m2.get_animation_manager().unwrap();
        dbg!(&animation_manager);
        animation_manager.update(6660.0);
        animation_manager.update(20.0);
        animation_manager.update(20.0);
        animation_manager.update(20.0);
        animation_manager.update(20.0);
        animation_manager.update(20.0);
        animation_manager.update(20.0);
        animation_manager.update(20.0);
        animation_manager.update(20.0);
        animation_manager.update(20.0);
        animation_manager.update(20.0);
        dbg!(animation_manager.calculated_texture_translations);
    }
}
