use deku::prelude::*;

struct Wdt<'a> {
    data: &'a [u8],
}

#[derive(Debug, DekuRead)]
struct Mphd {
    flags: u32,
    lgt_file_data_id: u32,
    occ_file_data_id: u32,
    fogs_file_data_id: u32,
    mpv_file_data_id: u32,
    tex_file_data_id: u32,
    wdl_file_data_id: u32,
    pd4_file_data_id: u32,  // PD4
}

#[derive(DekuRead, Debug)]
struct SMAreaInfo {
    flag_has_adt: u32,
    flag_all_water: u32,
    flag_loaded: u32,
    async_id: u32,
}

#[derive(DekuRead, Debug)]
struct MapFileDataid {
    root_adt: u32, // reference to fdid of mapname_xx_yy.adt
    obj0_adt: u32, // reference to fdid of mapname_xx_yy_obj0.adt
    obj1_adt: u32, // reference to fdid of mapname_xx_yy_obj1.adt
    tex0_adt: u32, // reference to fdid of mapname_xx_yy_tex0.adt
    lod_adt: u32,  // reference to fdid of mapname_xx_yy_lod.adt
    map_texture: u32, // reference to fdid of mapname_xx_yy.blp
    map_texture_n: u32, // reference to fdid of mapname_xx_yy_n.blp
    minimap_texture: u32, // reference to fdid of mapxx_yy.blp
}
