use deku::prelude::*;
use super::common::*;
use deku::bitvec::{BitVec, BitSlice, Msb0, Lsb0, bitvec, bits};
use wasm_bindgen::prelude::*;

#[derive(DekuRead, Debug, Clone)]
#[deku(magic = b"WDC4")]
pub struct Wdc4Db2Header {
    pub record_count: u32,
    pub field_count: u32,
    pub record_size: u32,
    pub string_table_size: u32,
    pub table_hash: u32,
    pub layout_hash: u32,
    pub min_id: u32,
    pub max_id: u32,
    pub locale: u32,
    pub flags: u16,
    pub id_index: u16,
    pub total_field_count: u32,
    pub bitpacked_data_offset: u32,
    pub lookup_column_count: u32,
    pub field_storage_info_size: u32,
    pub common_data_size: u32,
    pub palette_data_size: u32,
    pub section_count: u32,
}

#[derive(DekuRead, Debug, Clone)]
pub struct Wdc4Db2SectionHeader {
    pub tact_key_hash: u64,
    pub file_offset: u32,
    pub record_count: u32,
    pub string_table_size: u32,
    pub offset_records_end: u32,
    pub id_list_size: u32,
    pub relationship_data_size: u32,
    pub offset_map_id_count: u32,
    pub copy_table_count: u32,
}

#[derive(DekuRead, Debug, Clone)]
#[deku(type = "u32")]
pub enum StorageType {
    #[deku(id = "0")]
    None {
        unk1: u32,
        unk2: u32,
        unk3: u32,
    },
    #[deku(id = "1")]
    Bitpacked {
        offset_bits: u32,
        size_bits: u32,
        flags: u32,
    },
    #[deku(id = "2")]
    CommonData {
        default_value: u32,
        unk1: u32,
        unk2: u32,
    },
    #[deku(id = "3")]
    BitpackedIndexed {
        offset_bits: u32,
        size_bits: u32,
        unk1: u32,
    },
    #[deku(id = "4")]
    BitpackedIndexedArray {
        offset_bits: u32,
        size_bits: u32,
        unk1: u32,
    },
    #[deku(id = "5")]
    BitpackedSigned {
        offset_bits: u32,
        size_bits: u32,
        flags: u32,
    },
}

#[derive(DekuRead, Debug, Clone)]
pub struct Wdc4Db2FieldStruct {
    pub size: i16,
    pub position: u16,
}

#[derive(DekuRead, Debug, Clone)]
pub struct Wdc4Db2FieldInfo {
    pub field_offset_bits: u16,
    pub field_size_bits: u16,
    pub additional_data_size: u32,
    pub storage_type: StorageType,
}

#[derive(DekuRead, Debug, Clone)]
pub struct Wdc4Db2File {
    pub header: Wdc4Db2Header,
    #[deku(count = "header.section_count")]
    pub section_headers: Vec<Wdc4Db2SectionHeader>,
    #[deku(count = "header.total_field_count")]
    pub field_structs: Vec<Wdc4Db2FieldStruct>,
    #[deku(bytes_read = "header.field_storage_info_size")]
    pub field_storage_info: Vec<Wdc4Db2FieldInfo>,
    #[deku(count = "header.palette_data_size")]
    pub palette_data: Vec<u8>,
    #[deku(count = "header.common_data_size")]
    pub common_data: Vec<u8>,
}

fn bitslice_to_u32(bits: &BitSlice<u8, Msb0>, bit_offset: usize, num_bits: usize) -> u32 {
    let mut result: u32 = 0;
    for bit_num in bit_offset..bit_offset + num_bits {
        let byte_index = bit_num >> 3;
        let bit_index = 7 - (bit_num % 8);
        if bits[byte_index * 8 + bit_index] {
            result |= 1 << bit_num - bit_offset;
        }
    }
    result
}

fn from_u32<T>(v: u32) -> Result<T, DekuError>
    where for<'a> T: DekuRead<'a, ()>
{
    let v_bytes = v.to_le_bytes();
    let (_, result) = T::read(BitSlice::from_slice(&v_bytes), ())?;
    Ok(result)
}

impl Wdc4Db2File {
    pub fn print_palettes(&self) {
        for field_index in 0..self.field_storage_info.len() {
            let info = &self.field_storage_info[field_index];
            println!("{:?}", info);
            for palette_index in 0..info.additional_data_size / 4 {
                let palette_u32 = self.get_palette_data(field_index, palette_index as usize);
                println!("  {}: {} {}", palette_index, palette_u32, from_u32::<f32>(palette_u32).unwrap());
            }
        }
    }

    pub fn read_field<'a, T>(&self, input: &'a BitSlice<u8, Msb0>, bit_offset: usize, field_number: usize) -> Result<(&'a BitSlice<u8, Msb0>, T), DekuError>
        where for<'b> T: DekuRead<'b, ()>
    {
        let field_offset = self.field_storage_info[field_number].field_offset_bits as usize;
        let field_size = self.field_storage_info[field_number].field_size_bits as usize;
        let field_bits = &input[field_offset..field_offset + field_size];
        let result = match &self.field_storage_info[field_number].storage_type {
            StorageType::None { .. } => {
                let (_, result) = T::read(field_bits, ())?;
                result
            },
            StorageType::Bitpacked { offset_bits, size_bits, flags } => {
                let size_bits = *size_bits as usize;
                from_u32(bitslice_to_u32(&input, field_offset, size_bits))?
            },
            StorageType::CommonData { default_value, .. } => {
                let default = from_u32(*default_value)?;
                // TODO actually pull the value from common data
                if self.field_storage_info[field_number].additional_data_size > 0 {
                    todo!();
                }
                default
            },
            StorageType::BitpackedIndexed { offset_bits, size_bits, .. } => {
                let index = bitslice_to_u32(&input, field_offset, field_size);
                let palette_element = self.get_palette_data(field_number, index as usize);
                from_u32(palette_element)?
            },
            StorageType::BitpackedIndexedArray { .. } => todo!(),
            StorageType::BitpackedSigned { offset_bits, size_bits, flags } => {
                let size_bits = *size_bits as usize;
                from_u32(bitslice_to_u32(&input, field_offset, size_bits))?
            },
        };
        Ok((&input[field_offset + field_size..], result))
    }

    fn get_palette_data(&self, field_number: usize, palette_index: usize) -> u32 {
        let mut offset = 0;
        for field_number_i in 0..field_number {
            match &self.field_storage_info[field_number_i].storage_type {
                StorageType::BitpackedIndexed {..} | StorageType::BitpackedIndexedArray {..} => {
                    offset += self.field_storage_info[field_number_i].additional_data_size as usize;
                },
                _ => {},
            }
        }
        let start_index = offset + palette_index * 4;
        u32::from_le_bytes([
            self.palette_data[start_index + 0],
            self.palette_data[start_index + 1],
            self.palette_data[start_index + 2],
            self.palette_data[start_index + 3],
        ])
    }
}

pub struct Database<T> {
    db2: Wdc4Db2File,
    records: Vec<T>,
    ids: Vec<u32>,
}

impl<T> Database<T> {
    pub fn new(data: &[u8]) -> Result<Database<T>, String>
        where for<'a> T: DekuRead<'a, Wdc4Db2File>
    {
        let (_, db2) = Wdc4Db2File::from_bytes((&data, 0))
            .map_err(|e| format!("{:?}", e))?;
        let mut records: Vec<T> = Vec::with_capacity(db2.header.record_count as usize);
        let mut ids: Vec<u32> = Vec::with_capacity(db2.header.record_count as usize);
        let bitvec = BitVec::from_slice(&data[db2.section_headers[0].file_offset as usize..]);
        let mut rest = bitvec.as_bitslice();
        let mut id = db2.header.min_id;
        for _ in 0..db2.header.record_count {
            let (new_rest, value) = T::read(rest, db2.clone())
                .map_err(|e| format!("{:?}", e))?;
            records.push(value);
            ids.push(id);
            id += 1;
            let bits_read = rest.len() - new_rest.len();
            assert_eq!(db2.header.record_size as usize * 8, bits_read);
            rest = new_rest;
        }
        Ok(Database {
            db2,
            records,
            ids,
        })
    }

    pub fn get_record(&self, needle: u32) -> Option<&T> {
        let index = self.ids.iter().position(|haystack| *haystack == needle)?;
        Some(&self.records[index])
    }
}

#[derive(DekuRead, Debug, Clone)]
#[wasm_bindgen(js_name = "WowLightParamsRecord")]
#[deku(ctx = "db2: Wdc4Db2File")]
pub struct LightParamsRecord {
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 0)")]
    _celestial_overrides: Vec3,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 1)")]
    pub light_data_id: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 2)")]
    pub highlight_sky: bool,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 3)")]
    pub skybox_id: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 5)")]
    pub glow: f32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 6)")]
    pub water_shallow_alpha: f32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 7)")]
    pub water_deep_alpha: f32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 8)")]
    pub ocean_shallow_alpha: f32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 9)", pad_bits_after = "5")]
    pub ocean_deep_alpha: f32,
}

#[derive(DekuRead, Debug, Clone)]
#[wasm_bindgen(js_name = "WowLightDataRecord")]
#[deku(ctx = "db2: Wdc4Db2File")]
pub struct LightDataRecord {
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 0)")]
    pub light_param_id: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 1)")]
    pub time: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 2)")]
    pub direct_color: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 3)")]
    pub ambient_color: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 4)")]
    pub sky_top_color: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 5)")]
    pub sky_middle_color: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 6)")]
    pub sky_band1_color: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 7)")]
    pub sky_band2_color: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 8)")]
    pub sky_smog_color: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 9)")]
    pub sky_fog_color: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 10)")]
    pub sun_color: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 11)")]
    pub cloud_sun_color: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 12)")]
    pub cloud_emissive_color: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 13)")]
    pub cloud_layer1_ambient_color: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 14)")]
    pub cloud_layer2_ambient_color: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 15)")]
    pub ocean_close_color: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 16)")]
    pub ocean_far_color: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 17)")]
    pub river_close_color: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 18)")]
    pub river_far_color: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 19)")]
    pub shadow_opacity: u32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 20)")]
    pub fog_end: f32,
    #[deku(reader = "db2.read_field(deku::input_bits, deku::bit_offset, 21)", pad_bits_after = "32")]
    pub fog_scaler: f32,
}

#[derive(DekuRead, Debug, Clone)]
#[wasm_bindgen(js_name = "WowLightRecord")]
#[deku(ctx = "_: Wdc4Db2File")]
pub struct LightRecord {
    pub coords: Vec3,
    pub falloff_start: f32,
    pub falloff_end: f32,
    pub map_id: u16,
    light_param_ids: [u16; 8],
    pub unk: u16,
}

enum DistanceResult {
    Inner(f32),
    Outer(f32),
    None,
}

impl LightRecord {
    pub fn distance(&self, other: &Vec3) -> DistanceResult {
        let x = 17066.66 - self.coords.x / 36.0;
        let y = 17066.66 - self.coords.y / 36.0;
        let z = self.coords.z / 36.0;
        let distance = (
            (x - other.x).powi(2) +
            (y - other.y).powi(2) +
            (z - other.z).powi(2)
        ).sqrt();
        if distance < self.falloff_start {
            DistanceResult::Inner(distance)
        } else if distance < self.falloff_end {
            DistanceResult::Outer(distance)
        } else {
            DistanceResult::None
        }
    }
}

#[wasm_bindgen(js_name = "WowLightDescriptor", getter_with_clone)]
#[derive(Debug, Clone)]
pub struct LightDescriptor {
    pub light: LightRecord,
    pub light_data: Vec<LightDataRecord>,
    pub light_params: Vec<LightParamsRecord>,
}

#[wasm_bindgen(js_name = "WowLightingData", getter_with_clone)]
#[derive(Debug, Clone)]
pub struct LightingData {
    pub inner_light: LightDescriptor,
    pub outer_lights: Vec<LightDescriptor>,
}

#[wasm_bindgen(js_name = "WowLightDatabase")]
pub struct LightDatabase {
    lights: Database<LightRecord>,
    light_data: Database<LightDataRecord>,
    light_params: Database<LightParamsRecord>,
}

#[wasm_bindgen(js_class = "WowLightDatabase")]
impl LightDatabase {
    pub fn new(lights_db: &[u8], light_data_db: &[u8], light_params_db: &[u8]) -> Result<LightDatabase, String> {
        let lights = Database::new(lights_db)?;
        let light_data = Database::new(light_data_db)?;
        let light_params = Database::new(light_params_db)?;
        Ok(Self {
            lights,
            light_data,
            light_params,
        })
    }

    fn get_default_light(&self, map_id: u16, time: u32) -> LightDescriptor {
        let origin = Vec3::new(0.0);
        let default_light = self.lights.records.iter()
            .find(|light| light.map_id == map_id && light.coords == origin)
            .unwrap_or(self.lights.get_record(1).unwrap());
        self.get_light_descriptor(default_light, time)
    }

    fn get_light_descriptor(&self, light: &LightRecord, time: u32) -> LightDescriptor {
        let mut light_data = Vec::new();
        let mut light_params = Vec::new();
        for id in light.light_param_ids {
            if id == 0 {
                continue;
            }
            let light_param = self.light_params.get_record(id as u32).unwrap();
            // TODO: choose the most appropriate light_data for the given time
            let light_datum = self.light_data.records.iter()
                .find(|data| data.light_param_id == id as u32).unwrap();
            light_data.push(light_datum.clone());
            light_params.push(light_param.clone());
        }
        LightDescriptor {
            light: light.clone(),
            light_data,
            light_params,
        }
    }

    pub fn get_lighting_data(&self, map_id: u16, x: f32, y: f32, z: f32, time: u32) -> LightingData {
        let mut maybe_inner_light: Option<LightDescriptor> = None;
        let mut outer_lights: Vec<LightDescriptor> = Vec::new();
        let coord = Vec3 { x, y, z };

        for light in &self.lights.records {
            if light.map_id == map_id {
                match light.distance(&coord) {
                    DistanceResult::Inner(_) => {
                        assert!(maybe_inner_light.is_none());
                        maybe_inner_light = Some(self.get_light_descriptor(light, time));
                    },
                    DistanceResult::Outer(_) => outer_lights.push(self.get_light_descriptor(light, time)),
                    DistanceResult::None => {},
                }
            }
        }

        let inner_light = match maybe_inner_light {
            Some(light) => light,
            None => self.get_default_light(map_id, time),
        };

        LightingData {
            inner_light,
            outer_lights,
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_bitslicing() {
        let slice = BitSlice::from_slice(&[
            0, 0, 0, 0,
            0, 0, 0, 0,
            0, 0, 0, 0,
            0x01, 0x18, 0x00, 0x00,
        ]);
        assert_eq!(bitslice_to_u32(&slice, 96, 10), 1);
        assert_eq!(bitslice_to_u32(&slice, 106, 1), 0);
        assert_eq!(bitslice_to_u32(&slice, 107, 2), 3);
        assert_eq!(bitslice_to_u32(&slice, 109, 4), 0);
        assert_eq!(bitslice_to_u32(&slice, 113, 3), 0);
        assert_eq!(bitslice_to_u32(&slice, 116, 2), 0);
        assert_eq!(bitslice_to_u32(&slice, 118, 3), 0);
        assert_eq!(bitslice_to_u32(&slice, 121, 2), 0);
        let slice = BitSlice::from_slice(&[
            0, 0, 0, 0,
            0, 0, 0, 0,
            0, 0, 0, 0,
            0x02, 0x38, 0x0, 0x0,
        ]);
        assert_eq!(bitslice_to_u32(&slice, 96, 10), 2);
        assert_eq!(bitslice_to_u32(&slice, 106, 1), 0);
        assert_eq!(bitslice_to_u32(&slice, 107, 2), 3);
        assert_eq!(bitslice_to_u32(&slice, 109, 4), 1);
        assert_eq!(bitslice_to_u32(&slice, 113, 3), 0);
        assert_eq!(bitslice_to_u32(&slice, 116, 2), 0);
        assert_eq!(bitslice_to_u32(&slice, 118, 3), 0);
        assert_eq!(bitslice_to_u32(&slice, 121, 2), 0);
    }

    #[test]
    fn test() {
        let d1 = std::fs::read("../data/wow/dbfilesclient/light.db2").unwrap();
        let d2 = std::fs::read("../data/wow/dbfilesclient/lightparams.db2").unwrap();
        let d3 = std::fs::read("../data/wow/dbfilesclient/lightdata.db2").unwrap();
        let db = LightDatabase::new(&d1, &d3, &d2).unwrap();
        dbg!(db.get_lighting_data(209, 0.0, 0.0, 0.0, 0));
    }
}
