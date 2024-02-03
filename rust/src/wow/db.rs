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
#[deku(ctx = "db2: Wdc4Db2File")]
struct LightDataRecord {
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

#[wasm_bindgen(js_name = "WowLightResult")]
#[derive(Debug, Clone, Default)]
pub struct LightResult {
    pub glow: f32,
    pub water_shallow_alpha: f32,
    pub water_deep_alpha: f32,
    pub ocean_shallow_alpha: f32,
    pub ocean_deep_alpha: f32,
    pub highlight_sky: bool,
    pub direct_color: Vec3,
    pub ambient_color: Vec3,
    pub sky_top_color: Vec3,
    pub sky_middle_color: Vec3,
    pub sky_band1_color: Vec3,
    pub sky_band2_color: Vec3,
    pub sky_smog_color: Vec3,
    pub sky_fog_color: Vec3,
    pub sun_color: Vec3,
    pub cloud_sun_color: Vec3,
    pub cloud_emissive_color: Vec3,
    pub cloud_layer1_ambient_color: Vec3,
    pub cloud_layer2_ambient_color: Vec3,
    pub ocean_close_color: Vec3,
    pub ocean_far_color: Vec3,
    pub river_close_color: Vec3,
    pub river_far_color: Vec3,
    pub shadow_opacity: Vec3,
    pub fog_end: f32,
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
    fn distance(&self, other: &Vec3) -> DistanceResult {
        let distance = (
            (self.coords.x - other.x).powi(2) +
            (self.coords.y - other.y).powi(2) +
            (self.coords.z - other.z).powi(2)
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

fn u32_to_color(color: u32) -> Vec3 {
    Vec3 {
        x: ((color >> 0) & 0xff) as f32 / 255.0,
        y: ((color >> 8) & 0xff) as f32 / 255.0,
        z: ((color >> 16) & 0xff) as f32 / 255.0,
    }
}

impl LightResult {
    fn new(data: &LightDataRecord, params: &LightParamsRecord) -> Self {
        LightResult {
            glow: params.glow,
            water_shallow_alpha: params.water_shallow_alpha,
            water_deep_alpha: params.water_deep_alpha,
            ocean_shallow_alpha: params.ocean_shallow_alpha,
            ocean_deep_alpha: params.ocean_deep_alpha,
            highlight_sky: params.highlight_sky,
            direct_color: u32_to_color(data.direct_color),
            ambient_color: u32_to_color(data.ambient_color),
            sky_top_color: u32_to_color(data.sky_top_color),
            sky_middle_color: u32_to_color(data.sky_middle_color),
            sky_band1_color: u32_to_color(data.sky_band1_color),
            sky_band2_color: u32_to_color(data.sky_band2_color),
            sky_smog_color: u32_to_color(data.sky_smog_color),
            sky_fog_color: u32_to_color(data.sky_fog_color),
            sun_color: u32_to_color(data.sun_color),
            cloud_sun_color: u32_to_color(data.cloud_sun_color),
            cloud_emissive_color: u32_to_color(data.cloud_emissive_color),
            cloud_layer1_ambient_color: u32_to_color(data.cloud_layer1_ambient_color),
            cloud_layer2_ambient_color: u32_to_color(data.cloud_layer2_ambient_color),
            ocean_close_color: u32_to_color(data.ocean_close_color),
            ocean_far_color: u32_to_color(data.ocean_far_color),
            river_close_color: u32_to_color(data.river_close_color),
            river_far_color: u32_to_color(data.river_far_color),
            shadow_opacity: u32_to_color(data.shadow_opacity),
            fog_end: data.fog_end,
            fog_scaler: data.fog_scaler,
        }
    }
    fn add_scaled(&mut self, other: &LightResult, t: f32) {
        self.glow += other.glow * t;
        self.ambient_color += other.ambient_color * t;
        self.direct_color += other.direct_color * t;
        self.ambient_color += other.ambient_color * t;
        self.sky_top_color += other.sky_top_color * t;
        self.sky_middle_color += other.sky_middle_color * t;
        self.sky_band1_color += other.sky_band1_color * t;
        self.sky_band2_color += other.sky_band2_color * t;
        self.sky_smog_color += other.sky_smog_color * t;
        self.sky_fog_color += other.sky_fog_color * t;
        self.sun_color += other.sun_color * t;
        self.cloud_sun_color += other.cloud_sun_color * t;
        self.cloud_emissive_color += other.cloud_emissive_color * t;
        self.cloud_layer1_ambient_color += other.cloud_layer1_ambient_color * t;
        self.cloud_layer2_ambient_color += other.cloud_layer2_ambient_color * t;
        self.ocean_close_color += other.ocean_close_color * t;
        self.ocean_far_color += other.ocean_far_color * t;
        self.river_close_color += other.river_close_color * t;
        self.river_far_color += other.river_far_color * t;
        self.shadow_opacity += other.shadow_opacity * t;
    }
}

impl Lerp for LightResult {
    fn lerp(self, other: Self, t: f32) -> Self {
        LightResult {
            // should these lerp as well?
            water_shallow_alpha: self.water_shallow_alpha,
            water_deep_alpha: self.water_deep_alpha,
            ocean_shallow_alpha: self.ocean_shallow_alpha,
            ocean_deep_alpha: self.ocean_deep_alpha,
            highlight_sky: self.highlight_sky,

            glow: self.glow.lerp(other.glow, t),
            direct_color: self.direct_color.lerp(other.direct_color, t),
            ambient_color: self.ambient_color.lerp(other.ambient_color, t),
            sky_top_color: self.sky_top_color.lerp(other.sky_top_color, t),
            sky_middle_color: self.sky_middle_color.lerp(other.sky_middle_color, t),
            sky_band1_color: self.sky_band1_color.lerp(other.sky_band1_color, t),
            sky_band2_color: self.sky_band2_color.lerp(other.sky_band2_color, t),
            sky_smog_color: self.sky_smog_color.lerp(other.sky_smog_color, t),
            sky_fog_color: self.sky_fog_color.lerp(other.sky_fog_color, t),
            sun_color: self.sun_color.lerp(other.sun_color, t),
            cloud_sun_color: self.cloud_sun_color.lerp(other.cloud_sun_color, t),
            cloud_emissive_color: self.cloud_emissive_color.lerp(other.cloud_emissive_color, t),
            cloud_layer1_ambient_color: self.cloud_layer1_ambient_color.lerp(other.cloud_layer1_ambient_color, t),
            cloud_layer2_ambient_color: self.cloud_layer2_ambient_color.lerp(other.cloud_layer2_ambient_color, t),
            ocean_close_color: self.ocean_close_color.lerp(other.ocean_close_color, t),
            ocean_far_color: self.ocean_far_color.lerp(other.ocean_far_color, t),
            river_close_color: self.river_close_color.lerp(other.river_close_color, t),
            river_far_color: self.river_far_color.lerp(other.river_far_color, t),
            shadow_opacity: self.shadow_opacity.lerp(other.shadow_opacity, t),
            fog_end: self.fog_end.lerp(other.fog_end, t),
            fog_scaler: self.fog_scaler.lerp(other.fog_scaler, t),
        }
    }
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

    fn get_default_light(&self, map_id: u16, time: u32) -> LightResult {
        let origin = Vec3::new(0.0);
        let default_light = self.lights.records.iter()
            .find(|light| light.map_id == map_id && light.coords == origin)
            .unwrap_or(self.lights.get_record(1).unwrap());
        self.get_light_result(default_light, time)
    }

    fn get_light_result(&self, light: &LightRecord, time: u32) -> LightResult {
        let id = light.light_param_ids[0];
        assert!(id != 0);

        let light_param = self.light_params.get_record(id as u32).unwrap();

        // based on the given time, find the current and next LightDataRecord
        let mut current_light_data: Option<&LightDataRecord> = None;
        let mut next_light_data: Option<&LightDataRecord> = None;
        for light_data in &self.light_data.records {
            if light_data.light_param_id != id as u32 {
                continue;
            }
            if light_data.time <= time {
                if let Some(current) = current_light_data {
                    if light_data.time > current.time {
                        current_light_data = Some(light_data);
                    }
                } else {
                    current_light_data = Some(light_data);
                }
            } else {
                if let Some(next) = next_light_data {
                    if light_data.time < next.time {
                        next_light_data = Some(light_data);
                    }
                } else {
                    next_light_data = Some(light_data);
                }
            }
        }

        let current_light_data = current_light_data.unwrap();
        let mut final_result = LightResult::new(current_light_data, light_param);
        if current_light_data.time != std::u32::MAX {
            if let Some(next) = next_light_data {
                let next_full = LightResult::new(next, light_param);
                let t = 1.0 - (next.time - time) as f32 / (next.time - current_light_data.time) as f32;
                final_result = final_result.lerp(next_full.clone(), t);
            }
        }

        final_result
    }

    pub fn get_lighting_data(&self, map_id: u16, x: f32, y: f32, z: f32, time: u32) -> LightResult {
        let mut outer_lights: Vec<(LightResult, f32)> = Vec::new();
        let coord = Vec3 { x, y, z };

        for light in &self.lights.records {
            if light.map_id == map_id {
                match light.distance(&coord) {
                    DistanceResult::Inner(_) => return self.get_light_result(light, time),
                    DistanceResult::Outer(distance) => {
                        let alpha = 1.0 - (distance - light.falloff_start) / (light.falloff_end - light.falloff_start);
                        outer_lights.push((self.get_light_result(light, time), alpha))
                    },
                    DistanceResult::None => {},
                }
            }
        }

        if outer_lights.len() == 0 {
            return self.get_default_light(map_id, time);
        }

        outer_lights.sort_unstable_by(|(_, alpha_a), (_, alpha_b)| {
            alpha_a.partial_cmp(alpha_b).unwrap()
        });

        //let mut result = self.get_default_light(map_id, time);
        let mut result = LightResult::default();
        let mut total_alpha = 0.0;
        for (outer_result, mut alpha) in &outer_lights {
            if total_alpha >= 1.0 {
                break;
            }

            if total_alpha + alpha > 1.0 {
                alpha = 1.0 - total_alpha;
            }
            result.add_scaled(outer_result, alpha);
            total_alpha += alpha;
        }

        result
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
        let result = db.get_lighting_data(209, 0.0, 0.0, 0.0, 0);
        for color in [result.sky_top_color, result.sky_middle_color, result.sky_band1_color, result.sky_band2_color, result.sky_fog_color] {
            let color = color * 255.0;
            println!("{}, {}, {}", color.x, color.y, color.z);
        }
    }
}
