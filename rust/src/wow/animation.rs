use deku::prelude::*;
use wasm_bindgen::prelude::*;
use crate::wow::m2::*;
use crate::wow::common::*;

#[derive(DekuRead, Debug, Clone)]
pub struct M2CompBoneUnallocated {
    pub key_bone_id: i32,
    pub flags: u32,
    pub parent_bone: i16,
    pub submesh_id: u16,
    pub bone_name_crc: u32,
    pub translation: M2TrackUnallocated<Vec3>,
    pub rotation: M2TrackUnallocated<Quat16>,
    pub scaling: M2TrackUnallocated<Vec3>,
    pub pivot: Vec3,
}

#[derive(Debug, Clone)]
pub struct M2CompBone {
    pub key_bone_id: i32,
    pub flags: u32,
    pub parent_bone: i16,
    pub submesh_id: u16,
    pub translation: M2Track<Vec3>,
    pub rotation: M2Track<Quat16>,
    pub scaling: M2Track<Vec3>,
    pub pivot: Vec3,
}

#[derive(DekuRead, Debug, Clone)]
pub struct M2Sequence {
    pub id: u16, // lookup table id?
    pub sub_id: u16, // which number in a row of animations this one is
    pub duration: u32, // in milliseconds
    pub movespeed: f32, // speed the character moves with in the animation
    pub flags: u32,
    #[deku(pad_bytes_after = "2")]
    pub frequency: u16, // how often this should be played (for all animations of the same type, this adds up to 0x7fff)
    pub replay_min: u32,
    pub replay_max: u32,
    pub blend_time_in: u16,
    pub blend_time_out: u16,
    pub bounds_aabb: AABBox,
    pub bounds_radius: f32,
    pub variation_next: i16, // id of the next animation of this animation id, -1 if none
    pub alias_next: u16, // id in the list of animations, used to find actual animation if this sequence is an alias (flags & 0x40)
}

#[derive(DekuRead, Debug, Clone)]
pub struct M2TrackUnallocated<T> {
    pub interpolation_type: u16,
    pub global_sequence: i16,
    pub timestamps: WowArray<WowArray<u32>>,
    pub values: WowArray<WowArray<T>>,
}

impl<T> M2TrackUnallocated<T> {
    pub fn to_allocated(&self, data: &[u8]) -> Result<M2Track<T>, DekuError>
        where for<'a> T: DekuRead<'a> {
        let mut timestamps = Vec::new();
        for arr in self.timestamps.to_vec(data)? {
            timestamps.push(arr.to_vec(data)?);
        }

        let mut values = Vec::new();
        for arr in self.values.to_vec(data)? {
            values.push(arr.to_vec(data)?);
        }

        Ok(M2Track {
            interpolation_type: self.interpolation_type,
            global_sequence: self.global_sequence,
            timestamps,
            values,
        })
    }
}

#[derive(DekuRead, Debug, Clone)]
pub struct M2TextureTransformUnallocated {
    pub translation: M2TrackUnallocated<Vec3>,
    pub rotation: M2TrackUnallocated<Quat>,
    pub scaling: M2TrackUnallocated<Vec3>,
}

#[derive(DekuRead, Debug, Clone)]
pub struct M2ColorUnallocated {
    pub color: M2TrackUnallocated<Vec3>, // rgb
    pub alpha: M2TrackUnallocated<u16>, // 0 = transparent, 0x7FFF = opaque
}

#[derive(Debug, Clone)]
pub struct M2Track<T> {
    pub interpolation_type: u16,
    pub global_sequence: i16,
    pub timestamps: Vec<Vec<u32>>,
    pub values: Vec<Vec<T>>,
}

#[derive(Debug, Clone)]
pub struct M2TextureTransform {
    pub translation: M2Track<Vec3>,
    pub rotation: M2Track<Quat>,
    pub scaling: M2Track<Vec3>,
}

#[derive(Debug, Clone)]
pub struct M2TextureWeight {
    pub weights: M2Track<u16>,
}

// TODO: actually implement animation logic
impl M2TextureTransform {
    pub fn get_nth_translation(&self, anim_index: usize) -> Option<Vec3> {
        self.translation.values.get(anim_index)?.get(0).copied()
    }

    pub fn get_nth_rotation(&self, anim_index: usize) -> Option<Quat> {
        self.rotation.values.get(anim_index)?.get(0).copied()
    }

    pub fn get_nth_scaling(&self, anim_index: usize) -> Option<Vec3> {
        self.scaling.values.get(anim_index)?.get(0).copied()
    }
}

#[derive(Debug, Clone)]
pub struct M2Color {
    pub color: M2Track<Vec3>,
    pub alpha: M2Track<u16>,
}

impl M2Color {
    pub fn get_nth_color(&self, n: usize) -> Option<Vec3> {
        self.color.values.get(n)?.get(0).copied()
    }

    pub fn get_nth_alpha(&self, n: usize) -> Option<u16> {
        self.alpha.values.get(n)?.get(0).copied()
    }
}

#[wasm_bindgen(js_name = "WowM2AnimationState")]
#[derive(Debug, Clone)]
pub struct AnimationState {
    animation_index: usize,
    repeat_times: usize,
    animation_time: u32,
    animation_record: M2Sequence,
    main_variation_index: usize,
    main_variation_record: M2Sequence,
}

#[wasm_bindgen(js_name = "WowM2AnimationManager", getter_with_clone)]
#[derive(Debug, Clone)]
pub struct AnimationManager {
    global_loops: Vec<u32>,
    global_sequence_times: Vec<u32>,
    sequences: Vec<M2Sequence>,
    texture_weights: Vec<M2TextureWeight>,
    texture_transforms: Vec<M2TextureTransform>,
    animation_state: AnimationState,
    colors: Vec<M2Color>,
    bones: Vec<M2CompBone>,

    pub calculated_transparencies: Option<Vec<f32>>,
    pub calculated_texture_translations: Option<Vec<Vec3>>,
    pub calculated_texture_rotations: Option<Vec<Quat>>,
    pub calculated_texture_scalings: Option<Vec<Vec3>>,
    pub calculated_colors: Option<Vec<Vec4>>,
}

// rust-only
impl AnimationManager {
    pub fn new(
        global_loops: Vec<u32>,
        sequences: Vec<M2Sequence>,
        texture_weights: Vec<M2TextureWeight>,
        texture_transforms: Vec<M2TextureTransform>,
        colors: Vec<M2Color>,
        bones: Vec<M2CompBone>,
    ) -> Self {
        let global_sequence_times = vec![0; global_loops.len()];
        let animation_state = AnimationState {
            animation_index: 0,
            repeat_times: 0,
            animation_time: 0,
            animation_record: sequences[0].clone(),
            main_variation_index: 0,
            main_variation_record: sequences[0].clone(),
        };
        AnimationManager {
            global_loops,
            animation_state,
            sequences,
            texture_transforms,
            texture_weights,
            colors,
            bones,
            global_sequence_times,

            calculated_colors: None,
            calculated_texture_translations: None,
            calculated_texture_rotations: None,
            calculated_texture_scalings: None,
            calculated_transparencies: None,
        }
    }

    fn get_current_value<T>(&self, animation: &M2Track<T>, default: T) -> T
        where T: Clone
        {
        let mut curr_time = self.animation_state.animation_time;
        let mut animation_index = self.animation_state.animation_index;
        let mut max_time = self.animation_state.animation_record.duration;

        if (animation.global_sequence >= 0) {
            curr_time = self.global_sequence_times[animation.global_sequence as usize];
            max_time = self.global_loops[animation.global_sequence as usize];
        }

        if animation.timestamps.len() <= animation_index {
            animation_index = 0;
        }

        if animation.timestamps.len() == 0 || animation.timestamps.len() <= animation_index {
            return default;
        }

        if animation_index <= animation.timestamps.len() && animation.timestamps[animation_index].len() == 0 {
            return default;
        }

        let times = &animation.timestamps[animation_index];
        let values = &animation.values[animation_index];

        // find the index of the lowest timestamp >= curr_time (or the highest timestamp less than it)
        let time_index: i32;
        if max_time != 0 {
            if let Some(index) = times.iter().position(|time| *time >= curr_time) {
                time_index = index as i32;
            } else {
                time_index = match times.len() {
                    0 => -1,
                    len => len as i32 - 1,
                };
            }
        } else {
            time_index = 0;
        }

        if time_index == times.len() as i32 - 1 {
            return values[time_index as usize].clone();
        } else if time_index >= 0 {
            let value1 = &values[time_index as usize];
            let value2 = &values[time_index as usize + 1];
            let time1 = times[time_index as usize];
            let time2 = times[time_index as usize + 1];

            if animation.interpolation_type == 0 {
                return value1.clone();
            } else if animation.interpolation_type == 1 {
                // TODO lerp from value1 to value2
                return value1.clone();
            }
        } else {
            return values[0].clone();
        }
        default
    }
}

#[wasm_bindgen(js_class = "WowM2AnimationManager")]
impl AnimationManager {
    pub fn update(&mut self, delta_time: u32, globalDeltaTime: u32) {
        //self.animation_state.animation_time += delta_time;

        // TODO: global sequences?

        let mut colors = Vec::new();
        let default_color = Vec3::new(1.0);
        let default_alpha = 0x7fff;
        for color in &self.colors {
            let mut rgba = Vec4::new(0.0);
            let rgb = self.get_current_value(&color.color, default_color);
            rgba.x = rgb.x;
            rgba.y = rgb.y;
            rgba.z = rgb.z;
            rgba.w = self.get_current_value(&color.alpha, default_alpha) as f32 / 0x7fff as f32;
            colors.push(rgba);
        }
        self.calculated_colors = Some(colors);

        let mut transparencies = Vec::new();
        for weight in &self.texture_weights {
            transparencies.push(self.get_current_value(&weight.weights, default_alpha) as f32 / 0x7fff as f32);
        }
        self.calculated_transparencies = Some(transparencies);

        let mut translations = Vec::new();
        let mut rotations = Vec::new();
        let mut scalings = Vec::new();
        for _ in &self.texture_transforms {
            // TODO actually calculate these
            translations.push(Vec3::new(0.0));
            rotations.push(Quat { x: 0.0, y: 0.0, z: 0.0, w: 0.0 });
            scalings.push(Vec3::new(1.0));
        }
        self.calculated_texture_scalings = Some(scalings);
        self.calculated_texture_translations = Some(translations);
        self.calculated_texture_rotations = Some(rotations);
    }
}
