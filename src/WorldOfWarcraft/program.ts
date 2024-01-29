import { WowM2BlendingMode, WowPixelShader } from "../../rust/pkg/index.js";
import { rust } from "../rustlib.js";
import { GfxBindingLayoutDescriptor } from "../gfx/platform/GfxPlatform.js";
import { DeviceProgram } from "../Program.js";

export class BaseProgram extends DeviceProgram {
  public static numUniformBuffers = 2;
  public static ub_SceneParams = 0;
  public static ub_GlobalLightParams = 1;

  public static numSamplers = 0;

  public static calcLight = `
vec3 calcLight(
  vec3 diffuseColor,
  vec3 vNormal,
  vec3 accumLight,
  vec3 precomputedLight,
  vec3 specular,
  vec3 emissive) {
    vec3 linearDiffuseTerm = (diffuseColor * diffuseColor) * accumLight;

    return sqrt(linearDiffuseTerm) + specular + emissive;
}
  `;

  public static commonDeclarations = `
precision mediump float;

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
    Mat4x4 u_ModelView;
};

layout(std140) uniform ub_GlobalLightParams {
  vec3 directColor;
  vec3 ambientColor;
  vec3 skyTopColor;
  vec3 skyMiddleColor;
  vec3 skyBand1Color;
  vec3 skyBand2Color;
  vec3 skyFogColor;
  vec3 sunColor;
  vec3 cloudSunColor;
  vec3 cloudEmissiveColor;
  vec3 cloudLayer1AmbientColor;
  vec3 cloudLayer2AmbientColor;
  vec3 oceanCloseColor;
  vec3 oceanFarColor;
  vec3 riverCloseColor;
  vec3 riverFarColor;
  vec3 shadowOpacity;
  vec4 fogParams; // fogEnd, fogScaler
  vec4 waterAlphas; // waterShallow, waterDeep, oceanShallow, oceanDeep
  vec4 glow; // glow, highlightSky, _, _
};

${BaseProgram.calcLight}
  `;
}

export class WmoProgram extends BaseProgram {
  public static a_Position = 0;
  public static a_Normal = 1;
  public static a_Color = 2;
  public static a_TexCoord = 3;

  public static ub_ModelParams = 2;

  public static bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: super.numUniformBuffers + 1, numSamplers: super.numSamplers + 4 },
  ];

  public override both = `
${BaseProgram.commonDeclarations}

layout(std140) uniform ub_ModelParams {
    Mat4x4 u_Transform;
};

layout(binding = 0) uniform sampler2D u_Texture0;
layout(binding = 1) uniform sampler2D u_Texture1;
layout(binding = 2) uniform sampler2D u_Texture2;
layout(binding = 3) uniform sampler2D u_Texture3;

varying vec2 v_UV;
varying vec4 v_Color;

#ifdef VERT
layout(location = ${WmoProgram.a_Position}) attribute vec3 a_Position;
layout(location = ${WmoProgram.a_Normal}) attribute vec3 a_Normal;
layout(location = ${WmoProgram.a_Color}) attribute vec4 a_Color;
layout(location = ${WmoProgram.a_TexCoord}) attribute vec2 a_TexCoord;

void mainVS() {
    gl_Position = Mul(u_Projection, Mul(u_ModelView, Mul(u_Transform, vec4(a_Position, 1.0))));
    v_UV = a_TexCoord;
    v_Color = a_Color;
}
#endif

#ifdef FRAG
void mainPS() {
    vec4 tex = texture(SAMPLER_2D(u_Texture0), v_UV);
    bool enableAlpha = false; // TODO: bring in params, which will let us know whether to discard or not
    if (enableAlpha && tex.a < 0.5) {
      discard;
    }
    gl_FragColor = tex;
}
#endif
`;
}

export class TerrainProgram extends BaseProgram {
  public static a_Position = 0;
  public static a_Normal = 1;
  public static a_Color = 2;
  public static a_ChunkIndex = 3;
  public static a_Lighting = 4;

  public static bindingLayouts: GfxBindingLayoutDescriptor[] = [
      { numUniformBuffers: super.numUniformBuffers, numSamplers: super.numSamplers + 5 },
  ];

  public override both = `
${BaseProgram.commonDeclarations}

layout(binding = 0) uniform sampler2D u_Texture0;
layout(binding = 1) uniform sampler2D u_Texture1;
layout(binding = 2) uniform sampler2D u_Texture2;
layout(binding = 3) uniform sampler2D u_Texture3;
layout(binding = 4) uniform sampler2D u_AlphaTexture0;

varying vec3 v_Normal;
varying vec4 v_Color;
varying vec4 v_Lighting;
varying vec3 v_Binormal;
varying vec3 v_Tangent;
varying vec3 v_Position;
varying vec2 v_ChunkCoords;

#ifdef VERT
layout(location = ${TerrainProgram.a_Position}) attribute vec3 a_Position;
layout(location = ${TerrainProgram.a_Normal}) attribute vec3 a_Normal;
layout(location = ${TerrainProgram.a_Color}) attribute vec4 a_Color;
layout(location = ${TerrainProgram.a_Lighting}) attribute vec4 a_Lighting;
layout(location = ${TerrainProgram.a_ChunkIndex}) attribute float a_ChunkIndex;

void mainVS() {
    float iX = mod(a_ChunkIndex, 17.0);
    float iY = floor(a_ChunkIndex/17.0);

    if (iX > 8.01) {
        iY = iY + 0.5;
        iX = iX - 8.5;
    }

    v_ChunkCoords = vec2(iX, iY);
    v_Color = a_Color;
    v_Lighting = a_Lighting;
    gl_Position = Mul(u_Projection, Mul(u_ModelView, vec4(a_Position, 1.0)));
}
#endif

#ifdef FRAG
vec4 mixTex(vec4 tex0, vec4 tex1, float alpha) {
  return (alpha * (tex1 - tex0) + tex0);
}

void mainPS() {
    vec2 alphaCoord = v_ChunkCoords / 8.0;
    vec4 alphaBlend = texture(SAMPLER_2D(u_AlphaTexture0), alphaCoord);
    vec4 tex0 = texture(SAMPLER_2D(u_Texture0), v_ChunkCoords);
    vec4 tex1 = texture(SAMPLER_2D(u_Texture1), v_ChunkCoords);
    vec4 tex2 = texture(SAMPLER_2D(u_Texture2), v_ChunkCoords);
    vec4 tex3 = texture(SAMPLER_3D(u_Texture3), v_ChunkCoords);
    vec4 tex = mixTex(mixTex(mixTex(tex0, tex1, alphaBlend.g), tex2, alphaBlend.b), tex3, alphaBlend.a);
    vec4 diffuse = tex * 2.0 * v_Color;
    vec4 finalColor = vec4(0.0);
    finalColor.rgb = calcLight(
      diffuse.rgb,
      v_Normal,
      v_Lighting.rgb, // accumLight
      vec3(0.0), // precomputedLight
      vec3(0.0), // specular
      vec3(0.0) // emissive
    );
    finalColor.a = 1.0;

    gl_FragColor = finalColor;
}
#endif
`;
}

export const MAX_DOODAD_INSTANCES = 32;

export class ModelProgram extends BaseProgram {
  public static a_Position = 0;
  public static a_Normal = 1;
  public static a_TexCoord0 = 2;
  public static a_TexCoord1 = 3;

  public static ub_DoodadParams = 2;
  public static ub_MaterialParams = 3;

  public static bindingLayouts: GfxBindingLayoutDescriptor[] = [
      { numUniformBuffers: super.numUniformBuffers + 2, numSamplers: super.numSamplers + 4 },
  ];

  private static buildVertexShaderBlock(colorType: string, uvs: string[]): string {
    const colorAssignment = colorType === 'diffuse' ? `v_DiffuseColor = vec4(combinedColorHalved.r, combinedColorHalved.g, combinedColorHalved.b, combinedColor.a);`
      : colorType === 'color' ? `v_DiffuseColor = vec4(0.5, 0.5, 0.5, 1.0);`
      : colorType === 'edgeFade' ? `v_DiffuseColor = v_DiffuseColor = vec4(combinedColorHalved.r, combinedColorHalved.g, combinedColorHalved.b, combinedColor.a * edgeScanVal);`
      : `v_DiffuseColor = vec4(combinedColor.rgb * 0.5, combinedColor.a);`;
    const uvAssignments = uvs.map((uv, uvIndex) => {
      if (uv.startsWith('t')) {
        let n = parseInt(uv[1]);
        if (n < 2) {
          return `    v_UV${uvIndex} = Mul(texMat${n - 1}, vec4(a_TexCoord${n - 1}, 0.0, 1.0)).xy;`;
        } else {
          return `    v_UV${uvIndex} = v_UV${n};`
        }
      } else if (uv === 'env') {
        return `    v_UV${uvIndex} = envCoord;`;
      } else {
        throw `unrecognized uv ${uv}`;
      }
    }).join('\n');
    return `${colorAssignment}\n${uvAssignments}`
  }

  public override both = `
${BaseProgram.commonDeclarations}

layout(std140) uniform ub_DoodadParams {
    Mat4x4 u_Transform[${MAX_DOODAD_INSTANCES}];
};

layout(std140) uniform ub_MaterialParams {
    vec4 shaderTypes; // [pixelShader, vertexShader, _, _]
    vec4 materialParams; // [blendMode, unfogged, unlit, alphaTest]
    vec4 meshColor;
    Mat4x4 texMat0;
    Mat4x4 texMat1;
    vec4 textureWeight;
    Mat4x4 normalMat;
};

layout(binding = 0) uniform sampler2D u_Texture0;
layout(binding = 1) uniform sampler2D u_Texture1;
layout(binding = 1) uniform sampler2D u_Texture2;
layout(binding = 1) uniform sampler2D u_Texture3;

varying vec2 v_UV0;
varying vec2 v_UV1;
varying vec2 v_UV2;
varying vec2 v_UV3;
varying vec4 v_DiffuseColor;

#ifdef VERT
layout(location = ${ModelProgram.a_Position}) attribute vec3 a_Position;
layout(location = ${ModelProgram.a_Normal}) attribute vec3 a_Normal;
layout(location = ${ModelProgram.a_TexCoord0}) attribute vec2 a_TexCoord0;
layout(location = ${ModelProgram.a_TexCoord1}) attribute vec2 a_TexCoord1;

vec2 posToTexCoord(const vec3 vertexPosInView, const vec3 normal){
    //Blizz seems to have vertex in view space as vector from "vertex to eye", while in this implementation, it's
    //vector from "eye to vertex". So the minus here is not needed
    vec3 viewVecNormalized = normalize(vertexPosInView.xyz);
    vec3 reflection = reflect(viewVecNormalized, normalize(normal));
    vec3 temp_657 = vec3(reflection.x, reflection.y, (reflection.z + 1.0));

    return ((normalize(temp_657).xy * 0.5) + vec2(0.5));
}

float edgeScan(vec3 position, vec3 normal){
    float dotProductClamped = clamp(dot(-normalize(position),normal), 0.0, 1.0);
    return clamp(2.7* dotProductClamped * dotProductClamped - 0.4, 0.0, 1.0);
}

void mainVS() {
    gl_Position = Mul(u_Projection, Mul(u_ModelView, Mul(u_Transform[gl_InstanceID], vec4(a_Position, 1.0))));
    vec3 normal = normalize(Mul(normalMat, vec4(a_Normal, 0.0)).xyz);
    vec4 combinedColor = clamp(meshColor, 0.0, 1.0);
    vec4 combinedColorHalved = combinedColor * 0.5;
    vec2 envCoord = posToTexCoord(gl_Position.xyz, normal);
    float edgeScanVal = edgeScan(gl_Position.xyz, normal);
    int vertexShader = int(shaderTypes.g);

    v_UV0 = a_TexCoord0;
    v_UV1 = a_TexCoord1;
    v_UV2 = vec2(0.0);
    v_UV3 = vec2(0.0);

    if (vertexShader == ${rust.WowVertexShader.DiffuseT1}) {
      ${ModelProgram.buildVertexShaderBlock('diffuse', ['t1'])}
    } else if (vertexShader == ${rust.WowVertexShader.DiffuseEnv}) {
      ${ModelProgram.buildVertexShaderBlock('diffuse', ['env'])}
    } else if (vertexShader == ${rust.WowVertexShader.DiffuseT1T2}) {
      ${ModelProgram.buildVertexShaderBlock('diffuse', ['t1', 't2'])}
    } else if (vertexShader == ${rust.WowVertexShader.DiffuseT1Env}) {
      ${ModelProgram.buildVertexShaderBlock('diffuse', ['t1', 'env'])}
    } else if (vertexShader == ${rust.WowVertexShader.DiffuseEnvT1}) {
      ${ModelProgram.buildVertexShaderBlock('diffuse', ['env', 't1'])}
    } else if (vertexShader == ${rust.WowVertexShader.DiffuseEnvEnv}) {
      ${ModelProgram.buildVertexShaderBlock('diffuse', ['env', 'env'])}
    } else if (vertexShader == ${rust.WowVertexShader.DiffuseT1EnvT1}) {
      ${ModelProgram.buildVertexShaderBlock('diffuse', ['t1', 'env', 't1'])}
    } else if (vertexShader == ${rust.WowVertexShader.DiffuseT1T1}) {
      ${ModelProgram.buildVertexShaderBlock('diffuse', ['t1', 't1'])}
    } else if (vertexShader == ${rust.WowVertexShader.DiffuseT1T1T1}) {
      ${ModelProgram.buildVertexShaderBlock('diffuse', ['t1', 't1', 't1'])}
    } else if (vertexShader == ${rust.WowVertexShader.DiffuseEdgeFadeT1}) {
      ${ModelProgram.buildVertexShaderBlock('edgeFade', ['t1', 't1', 't1'])}
    } else if (vertexShader == ${rust.WowVertexShader.DiffuseT2}) {
      ${ModelProgram.buildVertexShaderBlock('diffuse', ['t1'])}
    } else if (vertexShader == ${rust.WowVertexShader.DiffuseT1EnvT2}) {
      ${ModelProgram.buildVertexShaderBlock('diffuse', ['t1', 'env', 't2'])}
    } else if (vertexShader == ${rust.WowVertexShader.DiffuseEdgeFadeT1T2}) {
      ${ModelProgram.buildVertexShaderBlock('edgeFade', ['t1', 't2'])}
    } else if (vertexShader == ${rust.WowVertexShader.DiffuseEdgeFadeEnv}) {
      ${ModelProgram.buildVertexShaderBlock('edgeFade', ['env'])}
    } else if (vertexShader == ${rust.WowVertexShader.DiffuseT1T2T1}) {
      ${ModelProgram.buildVertexShaderBlock('edgeFade', ['t1', 't2', 't1'])}
    } else if (vertexShader == ${rust.WowVertexShader.DiffuseT1T2T3}) {
      ${ModelProgram.buildVertexShaderBlock('edgeFade', ['t1', 't2', 't3'])}
    } else if (vertexShader == ${rust.WowVertexShader.ColorT1T2T3}) {
      ${ModelProgram.buildVertexShaderBlock('color', ['t1', 't2', 't3'])}
    } else if (vertexShader == ${rust.WowVertexShader.BWDiffuseT1}) {
      ${ModelProgram.buildVertexShaderBlock('bw', ['t1'])}
    } else if (vertexShader == ${rust.WowVertexShader.BWDiffuseT1T2}) {
      ${ModelProgram.buildVertexShaderBlock('bw', ['t1', 't2'])}
    }
}
#endif

#ifdef FRAG
void mainPS() {
    vec4 tex0 = texture(SAMPLER_2D(u_Texture0), v_UV0);
    vec4 tex1 = texture(SAMPLER_2D(u_Texture1), v_UV1);
    vec4 tex2 = texture(SAMPLER_2D(u_Texture2), v_UV2);
    vec4 tex3 = texture(SAMPLER_2D(u_Texture3), v_UV3);

    vec4 tex1WithUV0 = texture(SAMPLER_2D(u_Texture1), v_UV0);
    vec4 tex2WithUV0 = texture(SAMPLER_2D(u_Texture2), v_UV0);
    vec4 tex3WithUV1 = texture(SAMPLER_2D(u_Texture3), v_UV1);

    int pixelShader = int(shaderTypes.r);
    vec4 finalColor = vec4(1.0);
    vec3 specular = vec3(0.0);
    float finalOpacity = 0.0;
    bool canDiscard = false;
    float discardAlpha = 1.0;
    vec4 genericParams[3];
    genericParams[0] = vec4(1.0);
    genericParams[1] = vec4(1.0);
    genericParams[2] = vec4(1.0);
    vec3 matDiffuse;

    if (pixelShader == ${rust.WowPixelShader.CombinersOpaque}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersMod}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb;
        discardAlpha = tex0.a;
        canDiscard = true;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersOpaqueMod}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb * tex1.rgb;
        discardAlpha = tex1.a;
        canDiscard = true;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersOpaqueMod2x}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb * tex1.rgb * 2.0;
        discardAlpha = tex1.a * 2.0;
        canDiscard = true;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersOpaqueMod2xNA}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb * tex1.rgb * 2.0;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersOpaqueOpaque}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb * tex1.rgb;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersModMod}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb * tex1.rgb;
        discardAlpha = tex0.a * tex1.a;
        canDiscard = true;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersModMod2x}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb * tex1.rgb * 2.0;
        discardAlpha = tex0.a * tex1.a * 2.0;
        canDiscard = true;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersModAdd}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb;
        discardAlpha = tex0.a + tex1.a;
        canDiscard = true;
        specular = tex1.rgb;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersModMod2xNA}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb * tex1.rgb * 2.0;
        discardAlpha = tex0.a;
        canDiscard = true;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersModAddNA}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb;
        discardAlpha = tex0.a;
        canDiscard = true;
        specular = tex1.rgb;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersModOpaque}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb * tex1.rgb;
        discardAlpha = tex0.a;
        canDiscard = true;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersOpaqueMod2xNAAlpha}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * mix(tex0.rgb * tex1.rgb * 2.0, tex0.rgb, vec3(tex0.a));
    } else if (pixelShader == ${rust.WowPixelShader.CombinersOpaqueAddAlpha}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb;
        specular = tex1.rgb * tex1.a;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersOpaqueAddAlphaAlpha}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb;
        specular = tex1.rgb * tex1.a * (1.0 - tex0.a);
    } else if (pixelShader == ${rust.WowPixelShader.CombinersOpaqueMod2xNAAlphaAdd}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * mix(tex0.rgb * tex1.rgb * 2.0, tex0.rgb, vec3(tex0.a));
        specular = tex2.rgb * tex2.a * textureWeight.b;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersModAddAlpha}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb;
        discardAlpha = tex0.a;
        canDiscard = true;
        specular = tex1.rgb * tex1.a;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersModAddAlphaAlpha}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb;
        discardAlpha = tex0.a + tex1.a * (0.3 * tex1.r + 0.59 * tex1.g + 0.11 * tex1.b);
        canDiscard = true;
        specular = tex1.rgb * tex1.a * (1.0 - tex0.a);
    } else if (pixelShader == ${rust.WowPixelShader.CombinersOpaqueAlphaAlpha}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * mix(mix(tex0.rgb, tex1.rgb, vec3(tex1.a)), tex0.rgb, vec3(tex0.a));
    } else if (pixelShader == ${rust.WowPixelShader.CombinersOpaqueMod2xNAAlpha3s}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * mix(tex0.rgb * tex1.rgb * 2.0, tex2.rgb, vec3(tex2.a));
    } else if (pixelShader == ${rust.WowPixelShader.CombinersOpaqueAddAlphaWgt}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb;
        specular = tex1.rgb * tex1.a * textureWeight.g;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersModAddAlpha}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb;
        discardAlpha = tex0.a + tex1.a;
        canDiscard = true;
        specular = tex1.rgb * (1.0 - tex0.a);
    } else if (pixelShader == ${rust.WowPixelShader.CombinersOpaqueModNAAlpha}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * mix(tex0.rgb * tex1.rgb, tex0.rgb, vec3(tex0.a));
    } else if (pixelShader == ${rust.WowPixelShader.CombinersModAddAlphaWgt}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb;
        discardAlpha = tex0.a;
        canDiscard = true;
        specular = tex1.rgb * tex1.a * textureWeight.g;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersOpaqueModAddWgt}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * mix(tex0.rgb, tex1.rgb, vec3(tex1.a));
        specular = tex0.rgb * tex0.a * textureWeight.r;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersOpaqueMod2xNAAlphaUnshAlpha}) {
        float glowOpacity = clamp(tex2.a * textureWeight.b, 0.0, 1.0);
        matDiffuse = v_DiffuseColor.rgb * 2.0 * mix(tex0.rgb * tex1.rgb * 2.0, tex0.rgb, vec3(tex0.a)) * (1.0 - glowOpacity);
        specular = tex2.rgb * glowOpacity;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersModDualCrossfade}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * mix(mix(tex0, tex1WithUV0, vec4(clamp(textureWeight.g, 0.0, 1.0))), tex2WithUV0, vec4(clamp(textureWeight.b, 0.0, 1.0))).rgb;
        discardAlpha = mix(mix(tex0, tex1WithUV0, vec4(clamp(textureWeight.g, 0.0, 1.0))), tex2WithUV0, vec4(clamp(textureWeight.b, 0.0, 1.0))).a;
        canDiscard = true;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersOpaqueMod2xNAAlphaAlpha}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * mix(mix(tex0.rgb * tex1.rgb * 2.0, tex2.rgb, vec3(tex2.a)), tex0.rgb, vec3(tex0.a));
    } else if (pixelShader == ${rust.WowPixelShader.CombinersModMaskedDualCrossfade}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * mix(mix(tex0, tex1WithUV0, vec4(clamp(textureWeight.g, 0.0, 1.0))), tex2WithUV0, vec4(clamp(textureWeight.b, 0.0, 1.0))).rgb;
        discardAlpha = mix(mix(tex0, tex1WithUV0, vec4(clamp(textureWeight.g, 0.0, 1.0))), tex2WithUV0, vec4(clamp(textureWeight.b, 0.0, 1.0))).a * tex3WithUV1.a;
        canDiscard = true;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersOpaqueAlpha}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * mix(tex0.rgb, tex1.rgb, vec3(tex1.a));
    } else if (pixelShader == ${rust.WowPixelShader.Guild}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * mix(tex0.rgb * mix(genericParams[0].rgb, tex1.rgb * genericParams[1].rgb, vec3(tex1.a)), tex2.rgb * genericParams[2].rgb, vec3(tex2.a));
        discardAlpha = tex0.a;
        canDiscard = true;
    } else if (pixelShader == ${rust.WowPixelShader.GuildNoBorder}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb * mix(genericParams[0].rgb, tex1.rgb * genericParams[1].rgb, vec3(tex1.a));
        discardAlpha = tex0.a;
        canDiscard = true;
    } else if (pixelShader == ${rust.WowPixelShader.GuildOpaque}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * mix(tex0.rgb * mix(genericParams[0].rgb, tex1.rgb * genericParams[1].rgb, vec3(tex1.a)), tex2.rgb * genericParams[2].rgb, vec3(tex2.a));
    } else if (pixelShader == ${rust.WowPixelShader.CombinersModDepth}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb;
        discardAlpha = tex0.a;
        canDiscard = true;
    } else if (pixelShader == ${rust.WowPixelShader.Illum}) {
        discardAlpha = tex0.a;
        canDiscard = true;
    } else if (pixelShader == ${rust.WowPixelShader.CombinersModModModConst}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * (tex0 * tex1 * tex2 * genericParams[0]).rgb;
        discardAlpha = (tex0 * tex1 * tex2 * genericParams[0]).a;
        canDiscard = true;
    } else if (pixelShader == ${rust.WowPixelShader.NewUnkCombiner}) {
        matDiffuse = v_DiffuseColor.rgb * 2.0 * tex0.rgb * tex1.rgb;
        discardAlpha = tex0.a * tex1.a;
        canDiscard = true;
    }

    int blendMode = int(materialParams.r);
    if (blendMode == ${rust.WowM2BlendingMode.BlendAdd}) {
      finalOpacity = discardAlpha * v_DiffuseColor.a;
    } else if (blendMode == ${rust.WowM2BlendingMode.AlphaKey}) {
      finalOpacity = v_DiffuseColor.a;
      if (canDiscard && discardAlpha < 0.501960814) {
        discard;
      }
    } else if (blendMode == ${rust.WowM2BlendingMode.Opaque}) {
      finalOpacity = v_DiffuseColor.a;
    } else {
      finalOpacity = discardAlpha * v_DiffuseColor.a;
    }

    finalColor = vec4(matDiffuse, finalOpacity);
    
    gl_FragColor = finalColor;
}
#endif
`;
}
