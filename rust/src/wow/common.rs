use deku::{prelude::*, bitvec::BitVec, ctx::ByteSize};
use wasm_bindgen::prelude::*;
use std::ops::{Mul, AddAssign};

#[derive(DekuRead, Debug)]
pub struct Chunk {
    pub magic: [u8; 4],
    pub size: u32,
}

impl Chunk {
    pub fn parse_with_byte_size<T>(&self, data: &[u8]) -> Result<T, String>
        where for<'a> T: DekuRead<'a, ByteSize>
    {
        self.parse_inner(data, ByteSize(self.size as usize))
    }

    pub fn parse<T>(&self, data: &[u8]) -> Result<T, String>
        where for<'a> T: DekuRead<'a, ()>
    {
        self.parse_inner(data, ())
    }

    pub fn parse_array<T>(&self, data: &[u8], size_per_data: usize) -> Result<Vec<T>, String>
        where for<'a> T: DekuRead<'a, ()>
    {
        if self.size as usize % size_per_data != 0 {
            return Err(format!(
                "chunk size {} not evenly divisible by element size {}",
                self.size,
                size_per_data
            ));
        }
        let num_elements = self.size as usize / size_per_data;
        let bitvec = BitVec::from_slice(&data[..]);
        let mut result = Vec::with_capacity(num_elements);
        let mut rest = bitvec.as_bitslice();
        for _ in 0..num_elements {
            let (new_rest, element) = T::read(rest, ())
                .map_err(|e| format!("{:?}", e))?;
            result.push(element);
            rest = new_rest;
        }
        Ok(result)
    }

    fn parse_inner<T, V>(&self, data:&[u8], ctx: V) -> Result<T, String>
        where for<'a> T: DekuRead<'a, V>
    {
        let bitvec = BitVec::from_slice(&data[..]);
        let (_, element) = T::read(bitvec.as_bitslice(), ctx)
            .map_err(|e| format!("{:?}", e))?;
        Ok(element)
    }

    pub fn magic_str(&self) -> &str {
        std::str::from_utf8(&self.magic).unwrap()
    }
}

pub struct ChunkedData<'a> {
    pub data: &'a [u8],
    pub idx: usize,
}

impl<'a> ChunkedData<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        ChunkedData {
            data,
            idx: 0,
        }
    }
}

impl<'a> Iterator for ChunkedData<'a> {
    type Item = (Chunk, &'a [u8]);

    fn next(&mut self) -> Option<Self::Item> {
        if self.idx == self.data.len() {
            return None;
        }
        let (_, chunk) = Chunk::from_bytes((&self.data[self.idx..], 0)).unwrap();
        let chunk_start = self.idx + 8;
        let chunk_end = chunk_start + chunk.size as usize;
        let chunk_data = &self.data[chunk_start..chunk_end];
        self.idx = chunk_end;
        assert!(self.idx <= self.data.len());
        Some((chunk, chunk_data))
    }
}

pub type WowCharArray = WowArray<u8>;

impl WowArray<u8> {
    pub fn to_string(&self, data: &[u8]) -> Result<String, DekuError> {
        let bytes = self.to_vec(data)?;
        Ok(String::from_utf8(bytes).unwrap())
    }
}

#[wasm_bindgen(js_name = "WowQuat")]
#[derive(DekuRead, Debug, Clone, Copy)]
pub struct Quat {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

#[wasm_bindgen(js_name = "WowQuat16")]
#[derive(DekuRead, Debug, Clone, Copy)]
pub struct Quat16 {
    pub x: i16,
    pub y: i16,
    pub z: i16,
    pub w: i16,
}

#[wasm_bindgen(js_name = "WowVec3")]
#[derive(DekuRead, Debug, Default, Clone, Copy, PartialEq)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub fn new(v: f32) -> Self {
        Vec3 { x: v, y: v, z: v }
    }
}

#[wasm_bindgen(js_name = "WowVec4")]
#[derive(DekuRead, Debug, Clone, Copy)]
pub struct Vec4 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

impl Vec4 {
    pub fn new(v: f32) -> Self {
        Vec4 { x: v, y: v, z: v, w: v }
    }
}

#[wasm_bindgen(js_name = "WowVec2")]
#[derive(DekuRead, Debug, Clone, Copy)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

#[wasm_bindgen(js_name = "WowArgb")]
#[derive(DekuRead, Debug, Clone, Copy)]

pub struct Argb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

// Axis-aligned bounding box
#[wasm_bindgen(js_name = "WowAABBox")]
#[derive(DekuRead, Debug, Clone, Copy)]
pub struct AABBox {
    pub min: Vec3,
    pub max: Vec3,
}

impl AABBox {
    pub fn update(&mut self, x: f32, y: f32, z: f32) {
        if x < self.min.x { self.min.x = x; }
        if x > self.max.x { self.max.x = x; }
        if y < self.min.y { self.min.y = y; }
        if y > self.max.y { self.max.y = y; }
        if z < self.min.z { self.min.z = z; }
        if z > self.max.z { self.max.z = z; }
    }
}

#[derive(Debug, DekuRead, Clone, Copy)]
pub struct WowArray<T> {
    pub count: u32,
    pub offset: u32,
    #[deku(skip)]
    element_type: std::marker::PhantomData<T>,
}

impl<T> WowArray<T> where for<'a> T: DekuRead<'a> {
    pub fn to_vec(&self, data: &[u8]) -> Result<Vec<T>, DekuError> {
        let mut result = Vec::with_capacity(self.count as usize);
        let bitvec = BitVec::from_slice(&data[self.offset as usize..]);
        let mut bitslice = bitvec.as_bitslice();
        for _ in 0..self.count {
            let (new_bitslice, element) = T::read(bitslice, ())?;
            bitslice = new_bitslice;
            result.push(element);
        }
        Ok(result)
    }
}

#[derive(Debug, DekuRead)]
struct Mver {
    ver1: u32,
    ver2: u32,
}

pub trait Lerp {
    fn lerp(self, other: Self, t: f32) -> Self;
}

impl Lerp for f32 {
    fn lerp(self, other: Self, t: f32) -> Self {
        self * (1.0 - t) + other * t
    }
}

impl Lerp for u16 {
    fn lerp(self, other: Self, t: f32) -> Self {
        ((self as f32) * (1.0 - t) + (other as f32) * t) as u16
    }
}

impl Lerp for Vec3 {
    fn lerp(self, other: Self, t: f32) -> Self {
        Vec3 {
            x: self.x * (1.0 - t) + other.x * t,
            y: self.y * (1.0 - t) + other.y * t,
            z: self.z * (1.0 - t) + other.z * t,
        }
    }
}

impl AddAssign<Vec3> for Vec3 {
    fn add_assign(&mut self, other: Vec3) {
        self.x += other.x;
        self.y += other.y;
        self.z += other.z;
    }
}

impl Mul<f32> for Vec3 {
    type Output = Vec3;

    fn mul(self, rhs: f32) -> Self::Output {
        Vec3 {
            x: self.x * rhs,
            y: self.y * rhs,
            z: self.z * rhs,
        }
    }
}

impl Lerp for Quat {
    fn lerp(self, other: Self, t: f32) -> Self {
        Quat {
            x: self.x * (1.0 - t) + other.x * t,
            y: self.y * (1.0 - t) + other.y * t,
            z: self.z * (1.0 - t) + other.z * t,
            w: self.w * (1.0 - t) + other.w * t,
        }
    }
}