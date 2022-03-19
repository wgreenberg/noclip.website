use wasm_bindgen::prelude::wasm_bindgen;

use crate::unity::reader::*;
use crate::unity::asset::AssetInfo;
use crate::unity::mesh::{ Vec3f, Vec4f };
use crate::unity::version::{ UnityVersion, VersionType };

#[wasm_bindgen]
#[derive(Debug, Copy, Clone)]
pub struct PPtr {
    pub file_index: u32,
    pub path_id: i32,
}

impl Deserialize for PPtr {
    fn deserialize(reader: &mut AssetReader, _asset: &AssetInfo) -> Result<Self> {
        let file_index = reader.read_u32()?;
        let path_id = reader.read_i64()? as i32;
        Ok(PPtr { file_index, path_id })
    }
}

#[wasm_bindgen]
pub struct GameObject {
    pub path_id: Option<i32>,
    #[wasm_bindgen(skip)]
    pub components: Vec<PPtr>,
    #[wasm_bindgen(skip)]
    pub transform: Option<Transform>,
    #[wasm_bindgen(skip)]
    pub mesh_filter: Option<MeshFilter>,
    // TODO: MeshRenderer
    pub layer: u32,
    name: String,
    pub is_active: bool,
}

impl Deserialize for GameObject {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        let components = PPtr::deserialize_array(reader, asset)?;
        if components.iter().find(|ptr| ptr.file_index != 0).is_some() {
            let err_str = format!("Found GameObject component with non-zero file index");
            return Err(AssetReaderError::UnsupportedFeature(err_str));
        }

        Ok(GameObject {
            components,
            layer: reader.read_u32()?,
            name: reader.read_char_array()?,
            is_active: reader.read_bool()?,

            path_id: None,
            transform: None,
            mesh_filter: None,
        })
    }
}

#[wasm_bindgen]
impl GameObject {
    pub fn get_name(&self) -> String {
        self.name.clone()
    }

    pub fn from_bytes(data: Vec<u8>, asset: &AssetInfo, path_id: i32) -> std::result::Result<GameObject, String> {
        let mut reader = AssetReader::new(data);
        reader.set_endianness(asset.header.endianness);
        let mut obj = GameObject::deserialize(&mut reader, asset)?;
        obj.path_id = Some(path_id);
        return Ok(obj);
    }
}


#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub struct Quaternion {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

impl Deserialize for Quaternion {
    fn deserialize(reader: &mut AssetReader, _: &AssetInfo) -> Result<Self> {
        Ok(Quaternion {
            x: reader.read_f32()?,
            y: reader.read_f32()?,
            z: reader.read_f32()?,
            w: reader.read_f32()?,
        })
    }
}

#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct Transform {
    pub path_id: Option<i32>,
    pub game_object: PPtr,
    pub local_rotation: Quaternion,
    pub local_position: Vec3f,
    pub local_scale: Vec3f,
    #[wasm_bindgen(skip)]
    pub children: Vec<PPtr>, // pointer to Transforms
    #[wasm_bindgen(skip)]
    pub parent: PPtr, // pointer to Transform
}

impl Deserialize for Transform {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        let game_object = PPtr::deserialize(reader, asset)?;
        if game_object.file_index != 0 {
            let err_str = format!("Found Transform with non-zero GameObject file index");
            return Err(AssetReaderError::UnsupportedFeature(err_str));
        }
        let local_rotation = Quaternion::deserialize(reader, asset)?;
        let local_position = Vec3f::deserialize(reader, asset)?;
        let local_scale = Vec3f::deserialize(reader, asset)?;
        let v2021_2 = UnityVersion { major: 2021, minor: 2, ..Default::default() };
        if asset.metadata.unity_version >= v2021_2 {
            if asset.metadata.unity_version.version_type == VersionType::Final {
                reader.read_bool()?;
            }
            reader.align()?;
        }
        let children = PPtr::deserialize_array(reader, asset)?;
        let parent = PPtr::deserialize(reader, asset)?;
        Ok(Transform {
            path_id: None,
            game_object,
            local_position,
            local_rotation,
            local_scale,
            children,
            parent,
        })
    }
}

#[wasm_bindgen]
impl Transform {
    pub fn from_bytes(data: Vec<u8>, asset: &AssetInfo, path_id: i32) -> std::result::Result<Transform, String> {
        let mut reader = AssetReader::new(data);
        reader.set_endianness(asset.header.endianness);
        let mut obj = Transform::deserialize(&mut reader, asset)?;
        obj.path_id = Some(path_id);
        return Ok(obj);
    }

    pub fn is_root(&self) -> bool {
        self.parent.path_id == 0
    }

    pub fn get_children_path_ids(&self) -> Vec<i32> {
        self.children.iter().map(|ptr| ptr.path_id).collect()
    }
}

#[wasm_bindgen]
pub struct MeshFilter {
    pub path_id: Option<i32>,
    pub game_object: PPtr,
    pub mesh_ptr: PPtr,
}

impl Deserialize for MeshFilter {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        let game_object = PPtr::deserialize(reader, asset)?;
        let mesh_ptr = PPtr::deserialize(reader, asset)?;
        Ok(MeshFilter { path_id: None, game_object, mesh_ptr })
    }
}

#[wasm_bindgen]
impl MeshFilter {
    pub fn from_bytes(data: Vec<u8>, asset: &AssetInfo, path_id: i32) -> std::result::Result<MeshFilter, String> {
        let mut reader = AssetReader::new(data);
        reader.set_endianness(asset.header.endianness);
        let mut obj = MeshFilter::deserialize(&mut reader, asset)?;
        obj.path_id = Some(path_id);
        return Ok(obj);
    }
}

#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub struct StaticBatchInfo {
    pub first_submesh: u16,
    pub submesh_count: u16,
}

impl Deserialize for StaticBatchInfo {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        Ok(StaticBatchInfo {
            first_submesh: reader.read_u16()?,
            submesh_count: reader.read_u16()?,
        })
    }
}

#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct MeshRenderer {
    pub path_id: Option<i32>,
    pub game_object: PPtr,
    pub enabled: bool,
    materials: Vec<PPtr>,
    pub static_batch_info: StaticBatchInfo,
}

#[wasm_bindgen]
impl MeshRenderer {
    pub fn from_bytes(data: Vec<u8>, asset: &AssetInfo, path_id: i32) -> std::result::Result<MeshRenderer, String> {
        let mut reader = AssetReader::new(data);
        reader.set_endianness(asset.header.endianness);
        let mut obj = MeshRenderer::deserialize(&mut reader, asset)?;
        obj.path_id = Some(path_id);
        return Ok(obj);
    }
}

impl Deserialize for MeshRenderer {
    fn deserialize(reader: &mut AssetReader, asset: &AssetInfo) -> Result<Self> {
        let game_object = PPtr::deserialize(reader, asset)?;
        let enabled = reader.read_bool()?;
        let _cast_shadows = reader.read_u8()?;
        let _receive_shadows = reader.read_u8()?;
        let v2017_2 = UnityVersion { major: 2017, minor: 2, ..Default::default() };
        if asset.metadata.unity_version >= v2017_2 {
            let _dynamic_occludee = reader.read_u8()?;
        }
        let v2021 = UnityVersion { major: 2021, ..Default::default() };
        if asset.metadata.unity_version >= v2021 {
            let _static_shadow_caster = reader.read_u8()?;
        }
        let _motion_vectors = reader.read_u8()?;
        let _light_probe_usage = reader.read_u8()?;
        let _reflection_probe_usage = reader.read_u8()?;
        let v2019_3 = UnityVersion { major: 2019, minor: 3, ..Default::default() };
        if asset.metadata.unity_version >= v2019_3 {
            let _ray_tracing_mode = reader.read_u8()?;
        }
        let v2020 = UnityVersion { major: 2020, ..Default::default() };
        if asset.metadata.unity_version >= v2020 {
            let _ray_trace_procedural = reader.read_u8()?;
        }
        reader.align()?;
        let v2018 = UnityVersion { major: 2018, ..Default::default() };
        if asset.metadata.unity_version >= v2018 {
            let _rendering_layer_mask = reader.read_u32()?;
        }
        let v2018_3 = UnityVersion { major: 2018, minor: 3, ..Default::default() };
        if asset.metadata.unity_version >= v2018_3 {
            let _renderer_priority = reader.read_u32()?;
        }
        if asset.metadata.unity_version.version_type == VersionType::Final {
            let _lightmap_index = reader.read_u16()?;
            let _lightmap_index_dynamic = reader.read_u16()?;
            let _lightmap_tiling_offset = Vec4f::deserialize(reader, asset)?;
            let _lightmap_tiling_ffset_dynamic = Vec4f::deserialize(reader, asset)?;
        }
        let materials = PPtr::deserialize_array(reader, asset)?;
        let static_batch_info = StaticBatchInfo::deserialize(reader, asset)?;
        let _static_batch_root = PPtr::deserialize(reader, asset)?;
        let _probe_anchor = PPtr::deserialize(reader, asset)?;
        let _light_probe_volume_override = PPtr::deserialize(reader, asset)?;
        reader.align()?;
        let _sorting_layer_id = reader.read_i16()?;
        let _sorting_layer = reader.read_i16()?;
        let _sorting_order = reader.read_i16()?;
        reader.align()?;
        Ok(MeshRenderer {
            game_object,
            enabled,
            materials,
            static_batch_info,

            path_id: None,
        })
    }
}