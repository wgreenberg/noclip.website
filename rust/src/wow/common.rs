use deku::{prelude::*, bitvec::BitVec, ctx::ByteSize};
use wasm_bindgen::prelude::*;

#[derive(DekuRead, Debug)]
pub struct Chunk {
    pub magic: [u8; 4],
    pub size: u32,
}

impl Chunk {
    pub fn parse<T>(&self, data: &[u8]) -> Result<T, String>
        where for<'a> T: DekuRead<'a, ByteSize>
    {
        let bitvec = BitVec::from_slice(&data[..]);
        let ctx = ByteSize(self.size as usize);
        let (_, element) = T::read(bitvec.as_bitslice(), ctx)
            .map_err(|e| format!("{:?}", e))?;
        Ok(element)
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

#[wasm_bindgen]
#[derive(DekuRead, Debug, Clone, Copy)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[wasm_bindgen]
#[derive(DekuRead, Debug, Clone, Copy)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

// Axis-aligned bounding box
#[wasm_bindgen]
#[derive(DekuRead, Debug, Clone, Copy)]
pub struct AABBox {
    pub min: Vec3,
    pub max: Vec3,
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
