
import { mat4, vec3, vec4 } from 'gl-matrix';
import { HaloBSP, HaloBitmapReader, HaloLightmap, HaloMaterial, HaloModel, HaloModelPart, HaloSceneManager, HaloScenery, HaloSceneryInstance, HaloShaderEnvironment, HaloShaderModel, HaloShaderTransparencyChicago, HaloShaderTransparencyGeneric, HaloShaderTransparentChicagoMap, ShaderTransparentChicagoColorFunction } from '../../rust/pkg/index';
import { Camera, CameraController, computeViewSpaceDepthFromWorldSpacePoint } from '../Camera';
import { makeStaticDataBuffer } from '../gfx/helpers/BufferHelpers';
import { GfxShaderLibrary, glslGenerateFloat } from '../gfx/helpers/GfxShaderLibrary';
import { makeBackbufferDescSimple, pushAntialiasingPostProcessPass, standardFullClearRenderPassDescriptor } from '../gfx/helpers/RenderGraphHelpers';
import { convertToTriangleIndexBuffer, GfxTopology } from '../gfx/helpers/TopologyHelpers';
import { fillMatrix4x2, fillMatrix4x4, fillVec3v, fillVec4, fillVec4v } from '../gfx/helpers/UniformBufferHelpers';
import { GfxBindingLayoutDescriptor, GfxBlendFactor, GfxBlendMode, GfxBuffer, GfxBufferUsage, GfxCullMode, GfxDevice, GfxFrontFaceMode, GfxInputLayout, GfxInputLayoutBufferDescriptor, GfxInputState, GfxMipFilterMode, GfxProgram, GfxSamplerFormatKind, GfxTexFilterMode, GfxTextureDimension, GfxVertexAttributeDescriptor, GfxVertexBufferFrequency, GfxWrapMode } from '../gfx/platform/GfxPlatform';
import { GfxFormat } from "../gfx/platform/GfxPlatformFormat";
import { GfxRenderCache } from '../gfx/render/GfxRenderCache';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper';
import { GfxRendererLayer, GfxRenderInst, GfxRenderInstManager, makeSortKeyOpaque, setSortKeyDepth, setSortKeyLayer } from '../gfx/render/GfxRenderInstManager';
import { computeModelMatrixS, computeModelMatrixSRT, getMatrixTranslation } from '../MathHelpers';
import { DeviceProgram } from '../Program';
import { SceneContext } from '../SceneBase';
import { TextureMapping } from '../TextureHolder';
import { assert, nArray } from '../util';
import * as Viewer from '../viewer';
import { TextureCache } from './tex';
import { setAttachmentStateSimple } from '../gfx/helpers/GfxMegaStateDescriptorHelpers';

/**
 * todo:
 *   * decals/glowing elements/purple textures
 *   * fog
 *   * water
 */

const noclipSpaceFromHaloSpace = mat4.fromValues(
    1, 0,  0, 0,
    0, 0, -1, 0,
    0, 1,  0, 0,
    0, 0,  0, 1,
);

const scratchVec3a = vec3.create();

let _wasm: typeof import('../../rust/pkg/index') | null = null;

async function loadWasm() {
    if (_wasm === null) {
        _wasm = await import('../../rust/pkg/index');
    }
    return _wasm;
}

export function wasm() {
    assert(_wasm !== null);
    return _wasm!;
}

const enum SortKey {
    Translucent = GfxRendererLayer.TRANSLUCENT + 2,
    Skybox = GfxRendererLayer.TRANSLUCENT + 1,
}

class BaseProgram extends DeviceProgram {
    public static ub_SceneParams = 0;
    public static ub_ModelParams = 1;
    public static ub_BSPParams = 2;

    public static u_Texture = 0;
    public static u_Lightmap = 1;
    public static u_Bumpmap = 2;
    public static u_PrimaryDetailTexture = 3;
    public static u_SecondaryDetailTexture = 4;
    public static u_MicroDetailTexture = 5;
    public static u_ReflectionCubeMap = 6;
    public static u_MultipurposeMap = 7;

    public static common = `
precision mediump float;

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
    Mat4x4 u_ViewMatrix;
    vec3 u_PlayerPos;
};

layout(std140) uniform ub_ModelParams {
    Mat4x4 u_ModelMatrix;
};

layout(binding = ${BaseProgram.u_Texture}) uniform sampler2D u_Texture;
layout(binding = ${BaseProgram.u_Lightmap}) uniform sampler2D u_Lightmap;
layout(binding = ${BaseProgram.u_Bumpmap}) uniform sampler2D u_Bumpmap;
layout(binding = ${BaseProgram.u_PrimaryDetailTexture}) uniform sampler2D u_PrimaryDetailTexture;
layout(binding = ${BaseProgram.u_SecondaryDetailTexture}) uniform sampler2D u_SecondaryDetailTexture;
layout(binding = ${BaseProgram.u_MicroDetailTexture}) uniform sampler2D u_MicroDetailTexture;
layout(binding = ${BaseProgram.u_ReflectionCubeMap}) uniform samplerCube u_ReflectionCubeMap;
layout(binding = ${BaseProgram.u_MultipurposeMap}) uniform sampler2D u_MultipurposeMap;
`;
}

class BaseShaderProgram extends BaseProgram {
    public static ub_ShaderParams = 2;

    public static a_Pos = 0;
    public static a_Norm = 1;
    public static a_Binorm = 2;
    public static a_Tangent = 3;
    public static a_TexCoord = 4;

    public static varying = `
varying vec2 v_UV;
varying vec3 v_Normal;
varying vec3 v_Binormal;
varying vec3 v_Tangent;
varying vec3 v_Position;
`;

    public static includes = `
${GfxShaderLibrary.saturate}
`;

    public static header = `
${BaseProgram.common}
${BaseShaderProgram.includes}
${BaseShaderProgram.varying}
`;

    public override vert = `
${BaseShaderProgram.header}
layout(location = ${BaseShaderProgram.a_Pos}) attribute vec3 a_Position;
layout(location = ${BaseShaderProgram.a_Norm}) attribute vec3 a_Normal;
layout(location = ${BaseShaderProgram.a_Binorm}) attribute vec3 a_Binormal;
layout(location = ${BaseShaderProgram.a_Tangent}) attribute vec3 a_Tangent;
layout(location = ${BaseShaderProgram.a_TexCoord}) in vec2 a_TexCoord;

vec4 toWorldCoord(vec4 x) {
    return Mul(u_ModelMatrix, x);
}

void mainVS() {
    gl_Position = Mul(u_Projection, Mul(u_ViewMatrix, toWorldCoord(vec4(a_Position, 1.0))));
    v_UV = a_TexCoord;
    v_Normal = normalize(toWorldCoord(vec4(a_Normal.xyz, 0.0)).xyz);
    v_Binormal = normalize(toWorldCoord(vec4(a_Binormal.xyz, 0.0)).xyz);
    v_Tangent = normalize(toWorldCoord(vec4(a_Tangent.xyz, 0.0)).xyz);
    v_Position = toWorldCoord(vec4(a_Position.xyz, 1.0)).xyz;
}
`;

    public override frag = `
${BaseShaderProgram.header}

void mainPS() {
    //gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
    discard;
}
`;
}

class ShaderTransparencyGenericProgram extends BaseShaderProgram {
    constructor(public shader: HaloShaderTransparencyGeneric) {
        super()
        this.frag = this.generateFragSection();
    }

    private generateFragSection(): string {
        const fragBody: string[] = [];
        if (this.shader.first_map_type === _wasm!.ShaderTransparentGenericMapType.Map2D) {
            fragBody.push(`vec4 t0 = texture(SAMPLER_2D(u_Texture), v_UV);`);
        } else {
            fragBody.push(`vec3 t_EyeWorld = normalize(u_PlayerPos - v_Position);`);
            fragBody.push(`vec4 t0 = texture(SAMPLER_CUBE(u_ReflectionCubeMap), t_EyeWorld);`);
        }

        fragBody.push(`
vec4 t1 = texture(SAMPLER_2D(u_Lightmap), v_UV);
vec4 t2 = texture(SAMPLER_2D(u_Bumpmap), v_UV);
vec4 t3 = texture(SAMPLER_2D(u_PrimaryDetailTexture), v_UV);
gl_FragColor = t0;
`);

        return `
${BaseShaderProgram.header}

void mainPS() {
${fragBody.join('\n')}
}
`;
    }
}

class MaterialRender_TransparencyGeneric {
    private textureMapping: (TextureMapping | null)[] = nArray(8, () => null);
    private gfxProgram: GfxProgram;
    public sortKeyBase: number = 0;
    public visible = true;

    constructor(textureCache: TextureCache, cache: GfxRenderCache, private shader: HaloShaderTransparencyGeneric, private model: ModelRenderer) {
        this.textureMapping[1] = textureCache.getTextureMapping(shader.get_bitmap(1));
        this.textureMapping[2] = textureCache.getTextureMapping(shader.get_bitmap(2));
        this.textureMapping[3] = textureCache.getTextureMapping(shader.get_bitmap(3));
        if (shader.first_map_type === _wasm!.ShaderTransparentGenericMapType.Map2D) {
            this.textureMapping[0] = textureCache.getTextureMapping(shader.get_bitmap(0));
        } else {
            this.textureMapping[6] = textureCache.getTextureMapping(shader.get_bitmap(0));
        }

        this.gfxProgram = cache.createProgram(new ShaderTransparencyGenericProgram(shader));
        this.sortKeyBase = makeSortKeyOpaque(SortKey.Translucent, this.gfxProgram.ResourceUniqueId);
    }

    public setOnRenderInst(renderInst: GfxRenderInst): void {
        renderInst.setGfxProgram(this.gfxProgram);
        renderInst.setSamplerBindingsFromTextureMappings(this.textureMapping);

        const megaStateFlags = { depthWrite: false };
        setAttachmentStateSimple(megaStateFlags, {
            blendMode: GfxBlendMode.Add,
            blendSrcFactor: GfxBlendFactor.SrcAlpha,
            blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
        });
        renderInst.setMegaStateFlags(megaStateFlags);

        // XXX(jstpierre): Have to allocate something...
        let offs = renderInst.allocateUniformBuffer(ShaderModelProgram.ub_ShaderParams, 4);
    }

    public destroy(device: GfxDevice): void {
        this.shader.free();
    }
}

class ShaderTransparencyChicagoProgram extends BaseShaderProgram {
    constructor(public shader: HaloShaderTransparencyChicago) {
        super()
        this.frag = this.generateFragSection();
    }

    private vec2Literal(x: number, y: number): string {
        return `vec2(${glslGenerateFloat(x)}, ${glslGenerateFloat(y)})`;
    }

    private getMapUVTransform(map: HaloShaderTransparentChicagoMap): string {
        let scale, offset;
        if (map) {
            scale = this.vec2Literal(map.map_u_scale, map.map_v_scale);
            offset = this.vec2Literal(map.map_u_offset, map.map_v_offset);
        } else {
            scale = this.vec2Literal(0, 0);
            offset = this.vec2Literal(0, 0);
        }
        return `v_UV * ${scale} + ${offset}`;
    }

    private getColorFunction(out: string, current: string, next: string, fn: ShaderTransparentChicagoColorFunction): string {
        switch (fn) {
            case _wasm!.ShaderTransparentChicagoColorFunction.Current:
                return ``;
            case _wasm!.ShaderTransparentChicagoColorFunction.NextMap:
                return `${out} = ${next};`
            case _wasm!.ShaderTransparentChicagoColorFunction.Multiply:
                return `${out} = ${current} * ${next};`;
            case _wasm!.ShaderTransparentChicagoColorFunction.DoubleMultiply:
                return `${next} = 2.0 * ${current} * ${next};`;
            case _wasm!.ShaderTransparentChicagoColorFunction.Add:
                return `${out} = ${current} + ${next};`;
            default:
                throw new Error(`unrecognized ShaderTransparentChicagoColorFunction ${fn}`)
        }
    }

    private generateFragSection(): string {
        const maps = [];
        for (let i=0; i<4; i++) {
            const map = this.shader.get_map(i);
            if (map) {
                maps.push(map);
            }
        }
        const fragBody: string[] = [
            `vec4 t0 = texture(SAMPLER_2D(u_Texture), ${this.getMapUVTransform(maps[0])});`,
            `vec4 t1 = texture(SAMPLER_2D(u_Lightmap), ${this.getMapUVTransform(maps[1])});`,
            `vec4 t2 = texture(SAMPLER_2D(u_Bumpmap), ${this.getMapUVTransform(maps[2])});`,
            `vec4 t3 = texture(SAMPLER_2D(u_PrimaryDetailTexture), ${this.getMapUVTransform(maps[3])});`,
        ];

        fragBody.push(`vec4 scratch;`)
        fragBody.push(`vec4 current = t0;`)
        fragBody.push(`vec4 next;`)

        maps.forEach((map, i) => {
            fragBody.push(`next = t${i+1};`)
            fragBody.push(this.getColorFunction('scratch.rgb', 'current.rgb', 'next.rgb', map.color_function));
            fragBody.push(this.getColorFunction('scratch.a', 'current.a', 'next.a', map.color_function));
            fragBody.push(`current = scratch;`)
        })

        fragBody.push(`gl_FragColor = current;`)

        return `
${BaseShaderProgram.header}

void mainPS() {
${fragBody.join('\n')}
}
`;
    }
}

class MaterialRender_TransparencyChicago {
    private textureMapping: (TextureMapping | null)[] = nArray(8, () => null);
    private gfxProgram: GfxProgram;
    public sortKeyBase: number = 0;
    public visible = true;

    constructor(textureCache: TextureCache, cache: GfxRenderCache, private shader: HaloShaderTransparencyChicago, private model: ModelRenderer) {
        for (let i = 0; i < 4; i++)
            this.textureMapping[i] = textureCache.getTextureMapping(shader.get_bitmap(i));

        this.gfxProgram = cache.createProgram(new ShaderTransparencyChicagoProgram(shader));
        this.sortKeyBase = makeSortKeyOpaque(SortKey.Translucent, this.gfxProgram.ResourceUniqueId);
    }

    public setOnRenderInst(renderInst: GfxRenderInst): void {
        renderInst.setGfxProgram(this.gfxProgram);
        renderInst.setSamplerBindingsFromTextureMappings(this.textureMapping);

        const megaStateFlags = { depthWrite: false };
        setAttachmentStateSimple(megaStateFlags, {
            blendMode: GfxBlendMode.Add,
            blendSrcFactor: GfxBlendFactor.SrcAlpha,
            blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
        });
        renderInst.setMegaStateFlags(megaStateFlags);

        // XXX(jstpierre): Have to allocate something...
        let offs = renderInst.allocateUniformBuffer(ShaderModelProgram.ub_ShaderParams, 4);
    }

    public destroy(device: GfxDevice): void {
        this.shader.free();
    }
}

class ShaderModelProgram extends BaseProgram {
    public static ub_ShaderParams = 2;

    public static a_Pos = 0;
    public static a_Norm = 1;
    public static a_Binorm = 2;
    public static a_Tangent = 3;
    public static a_TexCoord = 4;

    public static varying = `
varying vec2 v_UV;
varying vec3 v_Normal;
varying vec3 v_Binormal;
varying vec3 v_Tangent;
varying vec3 v_Position;
`;

    public static includes = `
${GfxShaderLibrary.saturate}
`;

    public static BindingsDefinition = `
layout(std140) uniform ub_ShaderParams {
    Mat4x2 u_BaseMapTransform;
};
`;

    public static header = `
${BaseProgram.common}
${ShaderModelProgram.BindingsDefinition}
${ShaderModelProgram.includes}
${ShaderModelProgram.varying}
`;

    constructor(shader: HaloShaderModel) {
        super();
        this.frag = this.generateFragSection();
    }

    public override vert = `
${ShaderModelProgram.header}
layout(location = ${ShaderModelProgram.a_Pos}) attribute vec3 a_Position;
layout(location = ${ShaderModelProgram.a_Norm}) attribute vec3 a_Normal;
layout(location = ${ShaderModelProgram.a_Binorm}) attribute vec3 a_Binormal;
layout(location = ${ShaderModelProgram.a_Tangent}) attribute vec3 a_Tangent;
layout(location = ${ShaderModelProgram.a_TexCoord}) in vec2 a_TexCoord;

vec4 toWorldCoord(vec4 x) {
    return Mul(u_ModelMatrix, x);
}

void mainVS() {
    gl_Position = Mul(u_Projection, Mul(u_ViewMatrix, toWorldCoord(vec4(a_Position, 1.0))));
    v_UV = Mul(u_BaseMapTransform, vec4(a_TexCoord.xy, 1.0, 1.0)).xy;
    v_Normal = normalize(toWorldCoord(vec4(a_Normal.xyz, 0.0)).xyz);
    v_Binormal = normalize(toWorldCoord(vec4(a_Binormal.xyz, 0.0)).xyz);
    v_Tangent = normalize(toWorldCoord(vec4(a_Tangent.xyz, 0.0)).xyz);
    v_Position = toWorldCoord(vec4(a_Position.xyz, 1.0)).xyz;
}
`;

    private generateFragSection(): string {
        const fragBody: string[] = [];

        fragBody.push(`
vec4 t_BaseTexture = texture(SAMPLER_2D(u_Texture), v_UV).rgba;
gl_FragColor.rgba = t_BaseTexture.rgba;
if (t_BaseTexture.a < 0.5)
    discard;
`);

        return `
${ShaderModelProgram.header}

void mainPS() {
${fragBody.join('\n')}
}
`;
    }
}

class MaterialRender_Model {
    private textureMapping: (TextureMapping | null)[] = nArray(8, () => null);
    private gfxProgram: GfxProgram;
    public sortKeyBase: number = 0;
    public visible = true;

    constructor(textureCache: TextureCache, cache: GfxRenderCache, private shader: HaloShaderModel, private model: ModelRenderer) {
        this.textureMapping[0] = textureCache.getTextureMapping(shader.get_base_bitmap());
        this.textureMapping[1] = textureCache.getTextureMapping(shader.get_detail_bitmap());
        if (shader.has_reflection_cube_map)
            this.textureMapping[6] = textureCache.getTextureMapping(shader.get_reflection_cube_map());
        this.textureMapping[5] = textureCache.getTextureMapping(shader.get_multipurpose_map());

        this.gfxProgram = cache.createProgram(new ShaderModelProgram(shader));
        this.sortKeyBase = makeSortKeyOpaque(GfxRendererLayer.OPAQUE, this.gfxProgram.ResourceUniqueId);
    }

    public setOnRenderInst(renderInst: GfxRenderInst): void {
        renderInst.setGfxProgram(this.gfxProgram);
        renderInst.setSamplerBindingsFromTextureMappings(this.textureMapping);

        let offs = renderInst.allocateUniformBuffer(ShaderModelProgram.ub_ShaderParams, 16);
        const d = renderInst.mapUniformBufferF32(ShaderModelProgram.ub_ShaderParams);

        offs += fillMatrix4x2(d, offs, this.model.baseMapTransform);
    }

    public destroy(device: GfxDevice): void {
        this.shader.free();
    }
}

class ShaderEnvironmentProgram extends BaseProgram {
    public static ub_ShaderParams = 2;

    public static a_Pos = 0;
    public static a_Norm = 1;
    public static a_Binorm = 2;
    public static a_Tangent = 3;
    public static a_TexCoord = 4;
    public static a_IncidentLight = 5;
    public static a_LightmapTexCoord = 6;

    public static varying = `
varying vec2 v_UV;
varying vec2 v_lightmapUV;
varying vec3 v_Normal;
varying vec3 v_Binormal;
varying vec3 v_Tangent;
varying vec3 v_Position;
varying vec3 v_IncidentLight;
`;

    public static includes = `
${GfxShaderLibrary.saturate}

vec3 CalcTangentToWorld(in vec3 t_TangentNormal, in vec3 t_Basis0, in vec3 t_Basis1, in vec3 t_Basis2) {
    return t_TangentNormal.xxx * t_Basis0 + t_TangentNormal.yyy * t_Basis1 + t_TangentNormal.zzz * t_Basis2;
}
`;

    public static BindingsDefinition = `
layout(std140) uniform ub_ShaderParams {
    vec4 u_ReflectionPerpendicularColor;
    vec4 u_ReflectionParallelColor;
    vec4 u_Misc;
};

#define u_BSPIndex (u_Misc.x)
`;

    public static header = `
${BaseProgram.common}
${ShaderEnvironmentProgram.BindingsDefinition}
${ShaderEnvironmentProgram.includes}
${ShaderEnvironmentProgram.varying}
`;

    public override vert = `
${ShaderEnvironmentProgram.header}
layout(location = ${ShaderEnvironmentProgram.a_Pos}) attribute vec3 a_Position;
layout(location = ${ShaderEnvironmentProgram.a_Norm}) attribute vec3 a_Normal;
layout(location = ${ShaderEnvironmentProgram.a_Binorm}) attribute vec3 a_Binormal;
layout(location = ${ShaderEnvironmentProgram.a_Tangent}) attribute vec3 a_Tangent;
layout(location = ${ShaderEnvironmentProgram.a_TexCoord}) in vec2 a_TexCoord;
layout(location = ${ShaderEnvironmentProgram.a_IncidentLight}) in vec3 a_IncidentLight;
layout(location = ${ShaderEnvironmentProgram.a_LightmapTexCoord}) in vec2 a_LightmapTexCoord;

vec4 toWorldCoord(vec4 x) {
    return Mul(u_ModelMatrix, x);
}

void mainVS() {
    gl_Position = Mul(u_Projection, Mul(u_ViewMatrix, toWorldCoord(vec4(a_Position, 1.0))));
    v_UV = a_TexCoord;
    v_Normal = normalize(toWorldCoord(vec4(a_Normal.xyz, 0.0)).xyz);
    v_Binormal = normalize(toWorldCoord(vec4(a_Binormal.xyz, 0.0)).xyz);
    v_Tangent = normalize(toWorldCoord(vec4(a_Tangent.xyz, 0.0)).xyz);
    v_Position = toWorldCoord(vec4(a_Position.xyz, 1.0)).xyz;
    v_IncidentLight = a_IncidentLight;
    v_lightmapUV = a_LightmapTexCoord;
}
`;

    constructor(public shader: HaloShaderEnvironment | undefined, public has_lightmap: boolean) {
        super();
        this.generateFragmentShader();
    }

    private getDetailSection(fragBody: String[]): void {
        fragBody.push(`vec2 primaryUV = v_UV * ${this.shader!.primary_detail_bitmap_scale.toFixed(2)};`)
        fragBody.push(`vec4 primaryDetail = texture(SAMPLER_2D(u_PrimaryDetailTexture), primaryUV);`)
        fragBody.push(`vec2 secondaryUV = v_UV * ${this.shader!.secondary_detail_bitmap_scale.toFixed(2)};`)
        fragBody.push(`vec4 secondaryDetail = texture(SAMPLER_2D(u_SecondaryDetailTexture), secondaryUV);`)
        switch (this.shader!.shader_environment_type) {
            case _wasm!.ShaderEnvironmentType.Normal:
                fragBody.push(`vec4 blendedDetail = mix(secondaryDetail, primaryDetail, secondaryDetail.a);`)
                break;
            case _wasm!.ShaderEnvironmentType.Blended:
            case _wasm!.ShaderEnvironmentType.BlendedBaseSpecular:
                fragBody.push(`vec4 blendedDetail = mix(secondaryDetail, primaryDetail, color.a);`);
                break;
            default:
                throw new Error(`don't recognize ShaderEnvironmentType ${this.shader!.shader_environment_type}`);
        }
        
        if (this.shader!.has_primary_detail_bitmap) {
            switch (this.shader!.detail_bitmap_function) {
                case _wasm!.DetailBitmapFunction.DoubleBiasedMultiply:
                    fragBody.push(`color.rgb = saturate(2.0 * color.rgb * blendedDetail.rgb);`);
                    break;
                case _wasm!.DetailBitmapFunction.Multiply:
                    fragBody.push(`color.rgb = saturate(color.rgb * blendedDetail.rgb);`);
                    break;
                case _wasm!.DetailBitmapFunction.DoubleBiasedAdd:
                    fragBody.push(`color.rgb = saturate(color.rgb + 2.0 * blendedDetail.rgb - 1.0);`);
                    break;
                default:
                    throw new Error(`don't recognize DetailBitmapFunction ${this.shader!.detail_bitmap_function}`)
            }
        }
    }

    private getMicroDetailSection(fragBody: String[]): void {
        fragBody.push(`vec2 microUV = v_UV * ${this.shader!.micro_detail_bitmap_scale.toFixed(2)};`)
        fragBody.push(`vec4 microDetail = texture(SAMPLER_2D(u_MicroDetailTexture), microUV);`)
        switch (this.shader!.shader_environment_type) {
            case _wasm!.ShaderEnvironmentType.Normal:
                fragBody.push(`float specularReflectionMask = blendedDetail.a * base.a * microDetail.a;`)
                break;
            case _wasm!.ShaderEnvironmentType.Blended:
                fragBody.push(`float specularReflectionMask = blendedDetail.a * microDetail.a;`)
                break;
            case _wasm!.ShaderEnvironmentType.BlendedBaseSpecular:
                fragBody.push(`float specularReflectionMask = base.a * microDetail.a;`)
                break;
            default:
                throw new Error(`don't recognize ShaderEnvironmentType ${this.shader!.shader_environment_type}`);
        }
        
        if (this.shader!.has_micro_detail_bitmap) {
            switch (this.shader!.detail_bitmap_function) {
                case _wasm!.DetailBitmapFunction.DoubleBiasedMultiply:
                    fragBody.push(`color.rgb = saturate(2.0 * color.rgb  * microDetail.rgb);`)
                    break;
                case _wasm!.DetailBitmapFunction.Multiply:
                    fragBody.push(`color.rgb = saturate(color.rgb * microDetail.rgb);`)
                    break;
                case _wasm!.DetailBitmapFunction.DoubleBiasedAdd:
                    fragBody.push(`color.rgb = saturate(color.rgb + 2.0 * microDetail.rgb - 1.0);`)
                    break;
                default:
                    throw new Error(`don't recognize DetailBitmapFunction ${this.shader!.detail_bitmap_function}`)
            }
        }
    }

    private getReflectionSection(fragBody: String[]): void {
        fragBody.push(`
vec3 N = normalize(2.0 * dot(t_NormalWorld, t_EyeWorld) * t_NormalWorld - t_EyeWorld);
vec3 reflectionColor = texture(SAMPLER_CUBE(u_ReflectionCubeMap, N.xyz)).xyz;
vec3 specularColor = pow(reflectionColor, vec3(8.0));
float diffuseReflection = pow(dot(t_NormalWorld, t_EyeWorld), 2.0);
float attenuation = mix(u_ReflectionParallelColor.a, u_ReflectionPerpendicularColor.a, diffuseReflection);
vec3 tintColor = mix(u_ReflectionParallelColor.rgb, u_ReflectionPerpendicularColor.rgb, diffuseReflection);
vec3 tintedReflection = mix(specularColor, reflectionColor, tintColor);
vec3 finalColor = tintedReflection * attenuation;
color.rgb = saturate(color.rgb + finalColor * specularReflectionMask);
`);
    }

    private generateFragmentShader(): void {
        let fragBody = [];
        if (this.shader) {
            fragBody.push(`
vec4 base = texture(SAMPLER_2D(u_Texture), v_UV);
vec4 color = base;
vec2 t_BumpTexCoord = v_UV * ${this.shader!.bump_map_scale.toFixed(2)};
vec4 t_BumpMap = 2.0 * texture(SAMPLER_2D(u_Bumpmap), t_BumpTexCoord) - 1.0;
vec3 t_EyeWorld = normalize(u_PlayerPos - v_Position);
`);

            if (this.shader!.has_bump_map) {
                fragBody.push(`vec3 t_NormalWorld = normalize(CalcTangentToWorld(t_BumpMap.rgb, v_Tangent, v_Binormal, v_Normal));`);
            } else {
                fragBody.push(`vec3 t_NormalWorld = v_Normal;`);
            }

            if (this.has_lightmap) {
                fragBody.push(`
vec3 t_LightmapSample = texture(SAMPLER_2D(u_Lightmap), v_lightmapUV).rgb;
float t_Variance = dot(v_IncidentLight.rgb, v_IncidentLight.rgb);
float t_BumpAtten = (dot(v_IncidentLight, t_NormalWorld) * t_Variance) + (1.0 - t_Variance);
color.rgb *= t_LightmapSample * t_BumpAtten;
`);
            }

            if (!!(this.shader!.flags & 0x01)) {
                fragBody.push(`
if (t_BumpMap.a < 0.5)
    discard;
`);
            }

            this.getDetailSection(fragBody);
            this.getMicroDetailSection(fragBody);
            if (this.shader!.has_reflection_cube_map) {
                this.getReflectionSection(fragBody);
            }
        } else {
            fragBody.push(`vec4 color = vec4(1.0, 0.0, 1.0, 1.0);`);
        }
        fragBody.push(`gl_FragDepth = gl_FragCoord.z + 1e-6 * u_BSPIndex;`);
        fragBody.push(`gl_FragColor = vec4(color.rgb, 1.0);`);
        this.frag = `
${ShaderEnvironmentProgram.header}
void mainPS() {
${fragBody.join('\n')}
}
`;
    }
}

class LightmapRenderer {
    public lightmapMaterialRenderers: LightmapMaterialRenderer[];
    public inputLayout: GfxInputLayout;
    constructor(public device: GfxDevice, public textureCache: TextureCache, renderCache: GfxRenderCache, public trisBuf: GfxBuffer, public bsp: HaloBSP, public mgr: HaloSceneManager, public bspIndex: number, public lightmap: HaloLightmap, public lightmapTex: TextureMapping | undefined) {
        this.inputLayout = this.getInputLayout();
        this.lightmapMaterialRenderers = mgr.get_lightmap_materials(lightmap).map(material => {
            return new LightmapMaterialRenderer(this.device, this.textureCache, renderCache, material, this.inputLayout, this.mgr, this.bsp, this.trisBuf, lightmapTex!, this.bspIndex);
        });
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager, mainView: View): void {
        this.lightmapMaterialRenderers.forEach(r => r.prepareToRender(renderInstManager, mainView));
    }

    public destroy(device: GfxDevice) {
        this.lightmapMaterialRenderers.forEach(r => r.destroy(device));
        device.destroyInputLayout(this.inputLayout);
    }

    private getInputLayout(): GfxInputLayout {
        const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [];
        const vec3fSize = 3 * 4;
        const vec2fSize = 2 * 4;
        vertexAttributeDescriptors.push({ location: ShaderEnvironmentProgram.a_Pos, bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_RGB});
        vertexAttributeDescriptors.push({ location: ShaderEnvironmentProgram.a_Norm, bufferIndex: 0, bufferByteOffset: 1 * vec3fSize, format: GfxFormat.F32_RGB});
        vertexAttributeDescriptors.push({ location: ShaderEnvironmentProgram.a_Binorm, bufferIndex: 0, bufferByteOffset: 2 * vec3fSize, format: GfxFormat.F32_RGB});
        vertexAttributeDescriptors.push({ location: ShaderEnvironmentProgram.a_Tangent, bufferIndex: 0, bufferByteOffset: 3 * vec3fSize, format: GfxFormat.F32_RGB});
        vertexAttributeDescriptors.push({ location: ShaderEnvironmentProgram.a_TexCoord, bufferIndex: 0, bufferByteOffset: 4 * vec3fSize, format: GfxFormat.F32_RG});
        vertexAttributeDescriptors.push({ location: ShaderEnvironmentProgram.a_IncidentLight, bufferIndex: 1, bufferByteOffset: 0, format: GfxFormat.F32_RGB});
        vertexAttributeDescriptors.push({ location: ShaderEnvironmentProgram.a_LightmapTexCoord, bufferIndex: 1, bufferByteOffset: 1 * vec3fSize, format: GfxFormat.F32_RG});
        const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
            { byteStride: 4 * vec3fSize + vec2fSize, frequency: GfxVertexBufferFrequency.PerVertex },
            { byteStride: vec3fSize + vec2fSize, frequency: GfxVertexBufferFrequency.PerVertex },
        ];
        let indexBufferFormat: GfxFormat = GfxFormat.U16_R;
        return this.device.createInputLayout({ vertexAttributeDescriptors, vertexBufferDescriptors, indexBufferFormat });
    }
}

class ModelPart {
    private vertexBuffer: GfxBuffer;
    private indexBuffer: GfxBuffer;
    private inputLayout: GfxInputLayout;
    private inputState: GfxInputState;
    private indexCount = 0;
    public shaderIndex = 0;

    constructor(cache: GfxRenderCache, mgr: HaloSceneManager, private part: HaloModelPart) {
        const triStrips = mgr.get_model_part_indices(part);
        const indices = convertToTriangleIndexBuffer(GfxTopology.TriStrips, triStrips);
        this.indexCount = indices.length;

        const device = cache.device;
        this.indexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Index, indices.buffer);
        this.vertexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, mgr.get_model_part_vertices(part).buffer);

        this.inputLayout = this.getInputLayout(cache);
        this.inputState = device.createInputState(this.inputLayout, [{ buffer: this.vertexBuffer, byteOffset: 0 }], { buffer: this.indexBuffer, byteOffset: 0 });

        this.shaderIndex = part.shader_index;
    }

    private getInputLayout(cache: GfxRenderCache): GfxInputLayout {
        const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [];
        const vec3fSize = 3 * 4;
        vertexAttributeDescriptors.push({ location: ShaderModelProgram.a_Pos, bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_RGB});
        vertexAttributeDescriptors.push({ location: ShaderModelProgram.a_Norm, bufferIndex: 0, bufferByteOffset: 1 * vec3fSize, format: GfxFormat.F32_RGB});
        vertexAttributeDescriptors.push({ location: ShaderModelProgram.a_Binorm, bufferIndex: 0, bufferByteOffset: 2 * vec3fSize, format: GfxFormat.F32_RGB});
        vertexAttributeDescriptors.push({ location: ShaderModelProgram.a_Tangent, bufferIndex: 0, bufferByteOffset: 3 * vec3fSize, format: GfxFormat.F32_RGB});
        vertexAttributeDescriptors.push({ location: ShaderModelProgram.a_TexCoord, bufferIndex: 0, bufferByteOffset: 4 * vec3fSize, format: GfxFormat.F32_RG});
        const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
            { byteStride: 68, frequency: GfxVertexBufferFrequency.PerVertex },
        ];
        let indexBufferFormat: GfxFormat = GfxFormat.U16_R;
        return cache.createInputLayout({ vertexAttributeDescriptors, vertexBufferDescriptors, indexBufferFormat });
    }

    public setOnRenderInst(renderInst: GfxRenderInst): void {
        renderInst.setInputLayoutAndState(this.inputLayout, this.inputState);
        renderInst.drawIndexes(this.indexCount);
    }

    public destroy(device: GfxDevice): void {
        device.destroyBuffer(this.vertexBuffer);
        device.destroyBuffer(this.indexBuffer);
        device.destroyInputState(this.inputState);
        this.part.free();
    }
}

class ModelRenderer {
    private materialRenderers: (MaterialRender_Model | MaterialRender_TransparencyChicago | MaterialRender_TransparencyGeneric | null)[] = [];

    public baseMapTransform = mat4.create();

    // per part
    public parts: ModelPart[];
    public isSkybox: boolean = false;
    public visible = true;

    constructor(public device: GfxDevice, public textureCache: TextureCache, renderCache: GfxRenderCache, public bsp: HaloBSP, public mgr: HaloSceneManager, public model: HaloModel, public modelMatrix: mat4) {
        const shaders = mgr.get_model_shaders(this.model);
        shaders.forEach(shader => {
            if (shader instanceof _wasm!.HaloShaderModel) {
                this.materialRenderers.push(new MaterialRender_Model(textureCache, renderCache, shader, this));
            } else if (shader instanceof _wasm!.HaloShaderTransparencyGeneric) {
                this.materialRenderers.push(new MaterialRender_TransparencyGeneric(textureCache, renderCache, shader, this));
            } else if (shader instanceof _wasm!.HaloShaderTransparencyChicago) {
                this.materialRenderers.push(new MaterialRender_TransparencyChicago(textureCache, renderCache, shader, this));
            } else {
                this.materialRenderers.push(null);
            }
        });

        computeModelMatrixS(this.baseMapTransform, this.model.get_base_bitmap_u_scale(), this.model.get_base_bitmap_v_scale());

        this.parts = mgr.get_model_parts(this.model).map((part) => {
            return new ModelPart(renderCache, mgr, part);
        });
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager, mainView: View): void {
        if (!this.visible)
            return;

        const template = renderInstManager.pushTemplateRenderInst();

        let offs = template.allocateUniformBuffer(BaseProgram.ub_ModelParams, 16);
        let mapped = template.mapUniformBufferF32(BaseProgram.ub_ModelParams);
        offs += fillMatrix4x4(mapped, offs, this.modelMatrix);

        this.parts.forEach((part, partIdx) => {
            const materialRenderer = this.materialRenderers[part.shaderIndex];

            if (!materialRenderer)
                return; // Renderer will return...

            if (!materialRenderer.visible)
                return;

            const renderInst = renderInstManager.newRenderInst();
            part.setOnRenderInst(renderInst);
            materialRenderer.setOnRenderInst(renderInst);

            // TODO: Part AABB?
            renderInst.sortKey = materialRenderer.sortKeyBase;

            // XXX(jstpierre): This is a bit ugly... perhaps do skyboxen in a different render pass?
            if (this.isSkybox)
                renderInst.sortKey = setSortKeyLayer(renderInst.sortKey, SortKey.Skybox);

            getMatrixTranslation(scratchVec3a, this.modelMatrix);
            const depth = computeViewSpaceDepthFromWorldSpacePoint(mainView.viewFromWorldMatrix, scratchVec3a);
            renderInst.sortKey = setSortKeyDepth(renderInst.sortKey, depth);
            renderInstManager.submitRenderInst(renderInst);
        });

        renderInstManager.popTemplateRenderInst();
    }

    public destroy(device: GfxDevice) {
        this.parts.forEach((part) => part.destroy(device));
        this.materialRenderers.forEach((materialRenderer) => materialRenderer?.destroy(device));
    }
}

class SceneryRenderer {
    public modelRenderers: ModelRenderer[];
    public model: HaloModel;

    constructor(public device: GfxDevice, public textureCache: TextureCache, renderCache: GfxRenderCache, public bsp: HaloBSP, public mgr: HaloSceneManager, public scenery: HaloScenery, public instances: HaloSceneryInstance[]) {
        this.model = mgr.get_scenery_model(this.scenery)!;
        this.modelRenderers = this.instances.map(instance => {
            const instModelMatrix = mat4.create();
            computeModelMatrixSRT(instModelMatrix, 1, 1, 1,
                instance.rotation.roll, instance.rotation.pitch, instance.rotation.yaw,
                instance.position.x + this.scenery.origin_offset.x,
                instance.position.y + this.scenery.origin_offset.y,
                instance.position.z + this.scenery.origin_offset.z);
            return new ModelRenderer(this.device, this.textureCache, renderCache, this.bsp, this.mgr, this.model, instModelMatrix);
        });
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager, mainView: View): void {
        this.modelRenderers.forEach(m => m.prepareToRender(renderInstManager, mainView));
    }

    public destroy(device: GfxDevice) {
        this.modelRenderers.forEach(m => m.destroy(device));
    }
}

class BSPRenderer {
    public trisBuf: GfxBuffer;
    public lightmapRenderers: LightmapRenderer[];
    public sceneryRenderers: SceneryRenderer[];
    public skyboxRenderers: ModelRenderer[];

    constructor(public device: GfxDevice, public textureCache: TextureCache, renderCache: GfxRenderCache, public bsp: HaloBSP, public mgr: HaloSceneManager, public bspIndex: number) {
        this.trisBuf = makeStaticDataBuffer(device, GfxBufferUsage.Index, mgr.get_bsp_indices(this.bsp).buffer);
        const lightmapsBitmap = this.bsp.get_lightmaps_bitmap();
        this.lightmapRenderers = mgr.get_bsp_lightmaps(this.bsp).map(lightmap => {
            let lightmapTex: TextureMapping | undefined;
            if (lightmapsBitmap && lightmap.get_bitmap_index() !== 65535) {
                lightmapTex = this.textureCache.getTextureMapping(lightmapsBitmap!, lightmap.get_bitmap_index());
            }
            return new LightmapRenderer(this.device, this.textureCache, renderCache, this.trisBuf, this.bsp, this.mgr, this.bspIndex, lightmap, lightmapTex);
        });
        const sceneryInstances: HaloSceneryInstance[] = mgr.get_scenery_instances();
        this.sceneryRenderers = mgr.get_scenery_palette().map((scenery, i) => {
            const instances = sceneryInstances.filter(instance => instance.scenery_type === i);
            return new SceneryRenderer(this.device, this.textureCache, renderCache, this.bsp, this.mgr, scenery, instances);
        });
        this.skyboxRenderers = [];
        mgr.get_skies().map(sky => {
            const modelMatrix = mat4.create();
            const skyModel = sky.get_model();
            if (skyModel) {
                const model = new ModelRenderer(this.device, this.textureCache, renderCache, bsp, mgr, skyModel, modelMatrix);
                model.isSkybox = true;
                this.skyboxRenderers.push(model);
            }
        });
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager, mainView: View): void {
        this.lightmapRenderers.forEach(r => r.prepareToRender(renderInstManager, mainView));
        this.sceneryRenderers.forEach(r => r.prepareToRender(renderInstManager, mainView));
        this.skyboxRenderers.forEach(r => r.prepareToRender(renderInstManager, mainView));
    }

    public destroy(device: GfxDevice) {
        this.lightmapRenderers.forEach(r => r.destroy(device));
        this.sceneryRenderers.forEach(r => r.destroy(device));
        this.skyboxRenderers.forEach(r => r.destroy(device));
        device.destroyBuffer(this.trisBuf);
    }
}

class LightmapMaterialRenderer {
    public vertsBuf: GfxBuffer;
    public lightmapVertsBuf: GfxBuffer;
    public inputState: GfxInputState;
    public textureMapping: TextureMapping | null;
    public bumpMapping: TextureMapping | null;
    public primaryDetailMapping: TextureMapping | null;
    public secondaryDetailMapping: TextureMapping | null;
    public microDetailMapping: TextureMapping | null;
    public reflectionCubeMapping: TextureMapping | null;
    public program: GfxProgram;
    public shader: HaloShaderEnvironment | undefined;
    public perpendicularColor: vec4;
    public parallelColor: vec4;
    public modelMatrix: mat4;
    public numIndices: number;
    public indexOffset: number;

    constructor(device: GfxDevice, public textureCache: TextureCache, renderCache: GfxRenderCache, public material: HaloMaterial, public inputLayout: GfxInputLayout, public mgr: HaloSceneManager, public bsp: HaloBSP, public trisBuf: GfxBuffer, public lightmapMapping: TextureMapping | null, public bspIndex: number) {
        this.vertsBuf = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, mgr.get_material_vertex_data(this.material, this.bsp).buffer);
        this.modelMatrix = mat4.create();
        this.lightmapVertsBuf = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, mgr.get_material_lightmap_data(this.material, this.bsp).buffer);
        this.shader = mgr.get_material_shader(this.material);
        this.perpendicularColor = vec4.create();
        this.parallelColor = vec4.create();
        if (this.shader) {
            this.textureMapping = this.textureCache.getTextureMapping(this.shader.get_base_bitmap());
            this.bumpMapping = this.textureCache.getTextureMapping(this.shader.get_bump_map());
            this.primaryDetailMapping = this.textureCache.getTextureMapping(this.shader.get_primary_detail_bitmap());
            this.secondaryDetailMapping = this.textureCache.getTextureMapping(this.shader.get_secondary_detail_bitmap());
            this.microDetailMapping = this.textureCache.getTextureMapping(this.shader.get_micro_detail_bitmap());
            this.reflectionCubeMapping = this.shader && this.shader.has_reflection_cube_map ? this.textureCache.getTextureMapping(this.shader.get_reflection_cube_map()) : null;
            const perpendicular = this.shader.perpendicular_color;
            vec4.set(this.perpendicularColor, perpendicular.r, perpendicular.g, perpendicular.b, this.shader.perpendicular_brightness);
            perpendicular.free();
            const parallel = this.shader.parallel_color;
            vec4.set(this.parallelColor, parallel.r, parallel.g, parallel.b, this.shader.parallel_brightness);
            parallel.free();
        }
        this.program = renderCache.createProgram(new ShaderEnvironmentProgram(this.shader, !!this.lightmapMapping));
        this.numIndices = this.material.get_num_indices();
        this.indexOffset = this.material.get_index_offset();

        this.inputState = device.createInputState(this.inputLayout, [
            { buffer: this.vertsBuf, byteOffset: 0 },
            { buffer: this.lightmapVertsBuf, byteOffset: 0 },
        ], { buffer: this.trisBuf, byteOffset: 0 })
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager, mainView: View): void {
        const template = renderInstManager.pushTemplateRenderInst();
        template.setMegaStateFlags({ cullMode: GfxCullMode.Back, frontFace: GfxFrontFaceMode.CW });

        let offs = template.allocateUniformBuffer(ShaderEnvironmentProgram.ub_ShaderParams, 3 * 16);
        let mapped = template.mapUniformBufferF32(ShaderEnvironmentProgram.ub_ShaderParams);
        if (this.shader) {
            offs += fillVec4v(mapped, offs, this.perpendicularColor);
            offs += fillVec4v(mapped, offs, this.parallelColor);
            offs += fillVec4(mapped, offs, this.bspIndex);
        }

        {
            let offs = template.allocateUniformBuffer(BaseProgram.ub_ModelParams, 16);
            const mapped = template.mapUniformBufferF32(BaseProgram.ub_ModelParams);
            offs += fillMatrix4x4(mapped, offs, this.modelMatrix);
        }

        const renderInst = renderInstManager.newRenderInst();
        renderInst.setGfxProgram(this.program);
        renderInst.setSamplerBindingsFromTextureMappings([
            this.textureMapping,
            this.lightmapMapping,
            this.bumpMapping,
            this.primaryDetailMapping,
            this.secondaryDetailMapping,
            this.microDetailMapping,
            this.reflectionCubeMapping,
        ])
        renderInst.setInputLayoutAndState(this.inputLayout, this.inputState);
        renderInst.drawIndexes(this.numIndices, this.indexOffset);
        renderInstManager.submitRenderInst(renderInst);
        renderInstManager.popTemplateRenderInst();
    }

    public destroy(device: GfxDevice) {
        device.destroyBuffer(this.vertsBuf);
        device.destroyBuffer(this.lightmapVertsBuf);
        device.destroyInputState(this.inputState);
    }
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 3, numSamplers: 8, samplerEntries: [
        { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.Float, }, // 0
        { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.Float, }, // 1
        { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.Float, }, // 2
        { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.Float, }, // 3
        { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.Float, }, // 4
        { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.Float, }, // 5
        { dimension: GfxTextureDimension.Cube, formatKind: GfxSamplerFormatKind.Float, },// 6
        { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.Float, }, // 7
    ] },
];

// A "View" is effectively camera settings, but in Halo space.
class View {
    // aka viewMatrix
    public viewFromWorldMatrix = mat4.create();
    // aka worldMatrix
    public worldFromViewMatrix = mat4.create();
    public clipFromWorldMatrix = mat4.create();
    // aka projectionMatrix
    public clipFromViewMatrix = mat4.create();
    public cameraPos = vec3.create();

    public finishSetup(): void {
        mat4.invert(this.worldFromViewMatrix, this.viewFromWorldMatrix);
        mat4.mul(this.clipFromWorldMatrix, this.clipFromViewMatrix, this.viewFromWorldMatrix);
        getMatrixTranslation(this.cameraPos, this.worldFromViewMatrix);
    }

    public setupFromCamera(camera: Camera): void {
        mat4.mul(this.viewFromWorldMatrix, camera.viewMatrix, noclipSpaceFromHaloSpace);
        mat4.copy(this.clipFromViewMatrix, camera.projectionMatrix);
        this.finishSetup();
    }
}

class HaloScene implements Viewer.SceneGfx {
    private renderHelper: GfxRenderHelper;
    public textureCache: TextureCache;
    public bspRenderers: BSPRenderer[];
    private mainView = new View();

    constructor(public device: GfxDevice, public mgr: HaloSceneManager, public bitmapReader: HaloBitmapReader) {
        this.bspRenderers = [];
        this.renderHelper = new GfxRenderHelper(device);
        const gfxSampler = this.renderHelper.renderCache.createSampler({
            minFilter: GfxTexFilterMode.Bilinear,
            magFilter: GfxTexFilterMode.Bilinear,
            mipFilter: GfxMipFilterMode.Linear,
            minLOD: 0,
            maxLOD: 100,
            wrapS: GfxWrapMode.Repeat,
            wrapT: GfxWrapMode.Repeat,
        });
        this.textureCache = new TextureCache(this.device, gfxSampler, this.mgr, bitmapReader);
    }

    public adjustCameraController(c: CameraController) {
        c.setSceneMoveSpeedMult(1/1000);
    }

    public addBSP(bsp: HaloBSP, bspIndex: number) {
        this.bspRenderers.push(new BSPRenderer(this.device, this.textureCache, this.renderHelper.renderCache, bsp, this.mgr, bspIndex));
    }

    private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(bindingLayouts);

        this.mainView.setupFromCamera(viewerInput.camera);

        let offs = template.allocateUniformBuffer(BaseProgram.ub_SceneParams, 32 + 12);
        const mapped = template.mapUniformBufferF32(BaseProgram.ub_SceneParams);
        offs += fillMatrix4x4(mapped, offs, this.mainView.clipFromViewMatrix);
        offs += fillMatrix4x4(mapped, offs, this.mainView.viewFromWorldMatrix);
        offs += fillVec3v(mapped, offs, this.mainView.cameraPos);

        this.bspRenderers.forEach((r, i) => {
            r.prepareToRender(this.renderHelper.renderInstManager, this.mainView);
        })

        this.renderHelper.renderInstManager.popTemplateRenderInst();
        this.renderHelper.prepareToRender();
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
        const renderInstManager = this.renderHelper.renderInstManager;
        viewerInput.camera.setClipPlanes(0.01);

        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, standardFullClearRenderPassDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, standardFullClearRenderPassDescriptor);

        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
        builder.pushPass((pass) => {
            pass.setDebugName('Main');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                renderInstManager.drawOnPassRenderer(passRenderer);
            });
        });
        pushAntialiasingPostProcessPass(builder, this.renderHelper, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        this.prepareToRender(device, viewerInput);
        this.renderHelper.renderGraph.execute(builder);
        renderInstManager.resetRenderInsts();
    }

    public destroy(device: GfxDevice) {
        this.bspRenderers.forEach(r => r.destroy(device));
        this.textureCache.destroy(device);
        this.renderHelper.destroy();
    }
}

class Main {

}

const pathBase = `Halo1`;

class HaloSceneDesc implements Viewer.SceneDesc {
    constructor(public id: string, public name: string) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const dataFetcher = context.dataFetcher;
        const wasm = await loadWasm();
        wasm.init_panic_hook();
        const bitmapReader = await context.dataShare.ensureObject(`Halo1/BitmapReader`, async () => {
            const resourceMapData = await dataFetcher.fetchData(`${pathBase}/maps/bitmaps.map`);
            return wasm.HaloBitmapReader.new(resourceMapData.createTypedArray(Uint8Array));
        });
        const mapData = await dataFetcher.fetchData(`${pathBase}/maps/${this.id}.map`);
        const mapManager = wasm.HaloSceneManager.new(mapData.createTypedArray(Uint8Array));
        const renderer = new HaloScene(device, mapManager, bitmapReader);
        mapManager.get_bsps().forEach((bsp, i) => renderer.addBSP(bsp, i));
        return renderer;
    }

}

const id = 'Halo';
const name = 'Halo';

const sceneDescs = [
    new HaloSceneDesc("bloodgulch", "Blood Gulch"),
    new HaloSceneDesc("beavercreek", "beavercreek"),
    new HaloSceneDesc("boardingaction", "boardingaction"),
    new HaloSceneDesc("carousel", "carousel"),
    new HaloSceneDesc("chillout", "chillout"),
    new HaloSceneDesc("damnation", "damnation"),
    new HaloSceneDesc("dangercanyon", "dangercanyon"),
    new HaloSceneDesc("deathisland", "deathisland"),
    new HaloSceneDesc("gephyrophobia", "gephyrophobia"),
    new HaloSceneDesc("hangemhigh", "hangemhigh"),
    new HaloSceneDesc("icefields", "icefields"),
    new HaloSceneDesc("infinity", "infinity"),
    new HaloSceneDesc("longest", "longest"),
    new HaloSceneDesc("prisoner", "prisoner"),
    new HaloSceneDesc("putput", "putput"),
    new HaloSceneDesc("ratrace", "ratrace"),
    new HaloSceneDesc("sidewinder", "sidewinder"),
    new HaloSceneDesc("timberland", "timberland"),
    new HaloSceneDesc("wizard", "wizard"),
    new HaloSceneDesc("a10", "a10"),
    new HaloSceneDesc("a30", "a30"),
    new HaloSceneDesc("a50", "a50"),
    new HaloSceneDesc("b30", "b30"),
    new HaloSceneDesc("b40", "b40"),
    new HaloSceneDesc("c10", "c10"),
    new HaloSceneDesc("c20", "c20"),
    new HaloSceneDesc("c40", "c40"),
    new HaloSceneDesc("d20", "d20"),
    new HaloSceneDesc("d40", "d40"),
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs, hidden: false };