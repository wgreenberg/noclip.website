use deku::prelude::*;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = "WowColorEncoding")]
#[derive(Debug, DekuRead, Copy, Clone)]
#[deku(type = "u8")]
pub enum ColorEncoding {
    #[deku(id = "1")]
    Uncompressed,
    #[deku(id = "2")]
    Dxtc,
    #[deku(id = "3 | 4")]
    A8R8G8B8,
}

#[wasm_bindgen(js_name = "WowPixelFormat")]
#[derive(Debug, DekuRead, Copy, Clone)]
#[deku(type = "u8")]
pub enum PixelFormat {
    #[deku(id = "0")]
    Dxt1,
    #[deku(id = "1")]
    Dxt3,
    #[deku(id = "2")]
    Argb8888,
    #[deku(id = "3")]
    Argb1555,
    #[deku(id = "4")]
    Argb4444,
    #[deku(id = "5")]
    Rgb565,
    #[deku(id = "6")]
    A8,
    #[deku(id = "7")]
    Dxt5,
    #[deku(id = "8")]
    Unspecified,
    #[deku(id = "9")]
    Argb2565,
    #[deku(id = "11")]
    Pc511,
}

#[wasm_bindgen]
#[derive(Debug, DekuRead, Copy, Clone)]
#[deku(magic = b"BLP2")]
pub struct BlpHeader {
    _version: u32, // always 1 apparently
    pub color_encoding: ColorEncoding,
    pub alpha_bit_depth: u8,
    pub preferred_format: PixelFormat,
    pub has_mips: u8,
    pub width: u32,
    pub height: u32,
    mip_offsets: [u32; 16],
    mip_sizes: [u32; 16],
    palette: [u32; 256], // BGRA values
}

#[wasm_bindgen(js_name = "WowBlp")]
#[derive(Debug)]
pub struct Blp {
    texture_data: Vec<u8>,
    pub header: BlpHeader,
    pub file_id: u32,
}

#[wasm_bindgen(js_name = "WowBlpMipMetadata")]
pub struct BlpMipMetadata {
    pub offset: u32,
    pub size: u32,
}

#[wasm_bindgen(js_class = "WowBlp")]
impl Blp {
    pub fn new(file_id: u32, data: Vec<u8>) -> Result<Blp, String> {
        let ((texture_data, _), header) = BlpHeader::from_bytes((&data, 0))
            .map_err(|e| format!("{:?}", e))?;

        Ok(Blp {
            texture_data: texture_data.to_vec(),
            header,
            file_id,
        })
    }

    pub fn get_texture_data(&self) -> Result<Vec<u8>, String> {
        match (self.header.color_encoding, self.header.preferred_format) {
            (ColorEncoding::Uncompressed, _) => {
                let mut result = Vec::with_capacity(self.texture_data.len() * 4);
                for &idx in &self.texture_data {
                    let pixel: u32 = self.header.palette[idx as usize];
                    let [b, g, r, a] = pixel.to_le_bytes();
                    result.push(r);
                    result.push(g);
                    result.push(b);
                    result.push(a);
                }
                Ok(result)
            },
            (ColorEncoding::Dxtc, _) => Ok(self.texture_data.clone()),
            x => Err(format!("unsupported texture format combination: {:?}", x)),
        }
    }
}
