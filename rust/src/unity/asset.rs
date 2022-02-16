use crate::unity::version::UnityVersion;

#[derive(Debug)]
pub struct Asset {
    pub header: AssetHeader,
    pub metadata: AssetMetadata,
    pub objects: Vec<UnityObject>,
    pub script_types: Vec<ScriptType>,
    pub externals: Vec<External>,
    pub ref_types: Vec<SerializedType>,
    pub user_information: String,
}

#[derive(Debug)]
pub struct External {
    pub guid: Vec<u8>,
    pub ext_type: i32,
    pub path_name: String,
}

#[derive(Debug)]
pub struct ScriptType {
    pub local_serialized_file_index: i32,
    pub local_identifier_in_file: i64,
}

#[derive(Debug)]
pub struct UnityObject {
    pub path_id: i64,
    pub byte_start: i64,
    pub byte_size: u32,
    pub type_id: i32,
    pub serialized_type: SerializedType,
    pub class_id: i32,
}

#[derive(Debug, Clone)]
pub struct TypeTreeNode {
    pub level: usize,
    pub type_str: String,
    pub name: String,
    pub byte_size: usize,
    pub index: i32,
    pub type_flags: i32,
    pub version: i32,
    pub meta_flag: u32,
}

#[derive(Debug, Copy, Clone, PartialEq)]
pub enum Endianness {
    Big,
    Little,
}

#[derive(Debug)]
pub struct AssetHeader {
    pub metadata_size: usize,
    pub file_size: usize,
    pub version: u8,
    pub data_offset: usize,
    pub endianness: Endianness,
}

#[derive(Debug, Default, Clone)]
pub struct TypeTree {
    pub nodes: Vec<TypeTreeNode>,
    pub class_name: Option<String>,
    pub name_space: Option<String>,
    pub asm_name: Option<String>,
    pub type_dependencies: Option<Vec<i32>>,
}

#[derive(Debug, Clone)]
pub struct SerializedType {
    pub class_id: i32,
    pub is_stripped_type: bool,
    pub script_type_index: i16,
    pub type_tree: Option<TypeTree>,
    pub script_id: Vec<u8>,
    pub old_type_hash: Vec<u8>,
    pub type_dependencies: Vec<u32>,
    pub class_name: String,
    pub name_space: String,
    pub asm_name: String,
}

#[derive(Debug)]
pub struct AssetMetadata {
    pub unity_version: UnityVersion,
    pub target_platform: u32,
    pub enable_type_tree: bool,
    pub types: Vec<SerializedType>,
}