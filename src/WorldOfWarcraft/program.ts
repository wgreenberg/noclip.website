import { WowPixelShader } from "../../rust/pkg/index.js";
import { rust } from "../rustlib.js";
import { GfxBindingLayoutDescriptor } from "../gfx/platform/GfxPlatform.js";
import { DeviceProgram } from "../Program.js";

class BaseProgram extends DeviceProgram {
  public static numUniformBuffers = 1;
  public static ub_SceneParams = 0;

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

${BaseProgram.calcLight}
  `;
}

export class WmoProgram extends BaseProgram {
  public static a_Position = 0;
  public static a_Normal = 1;
  public static a_Color = 2;
  public static a_TexCoord = 3;

  public static ub_ModelParams = 1;

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

  public static ub_DoodadParams = 1;
  public static ub_MaterialParams = 2;

  public static bindingLayouts: GfxBindingLayoutDescriptor[] = [
      { numUniformBuffers: super.numUniformBuffers + 2, numSamplers: super.numSamplers + 2 },
  ];

  public override both = `
${BaseProgram.commonDeclarations}

layout(std140) uniform ub_DoodadParams {
    Mat4x4 u_Transform[${MAX_DOODAD_INSTANCES}];
};

layout(std140) uniform ub_MaterialParams {
    float fragShaderType;
    float vertShaderType;
    float blendMode;
    float unfogged;
    float unlit;
    float alphaTest;
    vec4 meshColor;
};

layout(binding = 0) uniform sampler2D u_Texture0;
layout(binding = 1) uniform sampler2D u_Texture1;

varying vec2 v_UV0;
varying vec2 v_UV1;

#ifdef VERT
layout(location = ${ModelProgram.a_Position}) attribute vec3 a_Position;
layout(location = ${ModelProgram.a_Normal}) attribute vec3 a_Normal;
layout(location = ${ModelProgram.a_TexCoord0}) attribute vec2 a_TexCoord0;
layout(location = ${ModelProgram.a_TexCoord1}) attribute vec2 a_TexCoord1;

void mainVS() {
    gl_Position = Mul(u_Projection, Mul(u_ModelView, Mul(u_Transform[gl_InstanceID], vec4(a_Position, 1.0))));
    v_UV0 = a_TexCoord0;
    v_UV1 = a_TexCoord1;
}
#endif

#ifdef FRAG
void mainPS() {
    vec4 tex0 = texture(SAMPLER_2D(u_Texture0), v_UV0);
    vec4 tex1 = texture(SAMPLER_2D(u_Texture1), v_UV1);
    int fragShader = int(fragShaderType);

    if (meshColor.a < alphaTest) {
      //discard;
    }

    vec4 finalColor = vec4(0.0);

    if (fragShader == ${rust.WowPixelShader.Opaque}) {
      finalColor.rgb = tex1.rgb * meshColor.rgb;
      finalColor.a = meshColor.a;
    } else if (fragShader == ${rust.WowPixelShader.Decal}) {
      finalColor.rgb = mix(meshColor.rgb, tex0.rgb, meshColor.a);
      finalColor.a = meshColor.a;
    } else if (fragShader == ${rust.WowPixelShader.Add}) {
      finalColor.rgba = tex0.rgba + meshColor.rgba;
    } else if (fragShader == ${rust.WowPixelShader.Mod2x}) {
      finalColor = tex0 * meshColor * 2.0;
    } else if (fragShader == ${rust.WowPixelShader.Fade}) {
      finalColor.rgb = mix(tex0.rgb, meshColor.rgb, meshColor.a);
      finalColor.a = meshColor.a;
    } else if (fragShader == ${rust.WowPixelShader.Mod}) {
      finalColor.rgb = meshColor.rgb * tex0.rgb;
      finalColor.a = meshColor.a * tex0.a;
    } else if (fragShader == ${rust.WowPixelShader.Opaque_Opaque}) {
      finalColor.rgb = (meshColor.rgb * tex0.rgb) * tex1.rgb;	
      finalColor.a = meshColor.a;
    } else if (fragShader == ${rust.WowPixelShader.Opaque_Add}) {
      finalColor.rgb = (meshColor.rgb * tex0.rgb) + tex1.rgb;
      finalColor.a = meshColor.a + tex1.a;
    } else if (fragShader == ${rust.WowPixelShader.Opaque_Mod2x}) {
      finalColor.rgb = (meshColor.rgb * tex0.rgb) * tex1.rgb * 2.0;
      finalColor.a = meshColor.a * tex1.a * 2.0;
    } else if (fragShader == ${rust.WowPixelShader.Opaque_Mod2xNA}) {
      finalColor.rgb = (meshColor.rgb * tex0.rgb) * tex1.rgb * 2.0;
      finalColor.a = meshColor.a;
    } else if (fragShader == ${rust.WowPixelShader.Opaque_AddNA}) {
      finalColor.rgb = (meshColor.rgb * tex0.rgb) + tex1.rgb;	
      finalColor.a = meshColor.a;
    } else if (fragShader == ${rust.WowPixelShader.Opaque_Mod}) {
      finalColor.rgb = (meshColor.rgb * tex0.rgb) * tex1.rgb;	
      finalColor.a = meshColor.a * tex1.a;
    } else if (fragShader == ${rust.WowPixelShader.Mod_Opaque}) {
      finalColor.rgb = (meshColor.rgb * tex0.rgb) * tex1.rgb;	
      finalColor.a = meshColor.a * tex0.a;
    } else if (fragShader == ${rust.WowPixelShader.Mod_Add}) {
      finalColor.rgb = (meshColor.rgb * tex0.rgb) + tex1.rgb;	
      finalColor.a = (meshColor.a * tex0.a) + tex1.a;
    } else if (fragShader == ${rust.WowPixelShader.Mod_Mod2x}) {
      finalColor.rgb = (meshColor.rgb * tex0.rgb) * tex1.rgb * 2.0;	
      finalColor.a = (meshColor.a * tex0.a) * tex1.a * 2.0;
    } else if (fragShader == ${rust.WowPixelShader.Mod_Mod2xNA}) {
      finalColor.rgb = (meshColor.rgb * tex0.rgb) * tex1.rgb * 2.0;	
      finalColor.a = meshColor.a * tex0.a;
    } else if (fragShader == ${rust.WowPixelShader.Mod_AddNA}) {
      finalColor.rgb = (meshColor.rgb * tex0.rgb) + tex1.rgb;	
      finalColor.a = meshColor.a * tex0.a;
    } else if (fragShader == ${rust.WowPixelShader.Mod_Mod}) {
      finalColor.rgb = (meshColor.rgb * tex0.rgb) * tex1.rgb;	
      finalColor.a = (meshColor.a * tex0.a) * tex1.a;
    } else if (fragShader == ${rust.WowPixelShader.Add_Mod}) {
      finalColor.rgb = (meshColor.rgb + tex0.rgb) * tex1.rgb;	
      finalColor.a = (meshColor.a + tex0.a) * tex1.a;
    } else if (fragShader == ${rust.WowPixelShader.Mod2x_Mod2x}) {
      finalColor.rgb = (meshColor.rgb * tex0.rgb) * tex1.rgb * 4.0;	
      finalColor.a = tex0.a * tex1.a * 4.0;
    } else if (fragShader == ${rust.WowPixelShader.Opaque_Mod2xNA_Alpha}) {
      finalColor.rgb = (meshColor.rgb * tex0.rgb) * mix(tex1.rgb * 2.0, vec3(1.0), tex0.a);	
      finalColor.a = meshColor.a;
    } else if (fragShader == ${rust.WowPixelShader.Opaque_AddAlpha}) {
      finalColor.rgb = (meshColor.rgb * tex0.rgb) + (tex1.rgb * tex1.a);
      finalColor.a = meshColor.a;
    } else if (fragShader == ${rust.WowPixelShader.Opaque_AddAlpha_Alpha}) {
      finalColor.rgb = (meshColor.rgb * tex0.rgb) + (tex1.rgb * tex1.a * tex0.a);
      finalColor.a = meshColor.a;
    }

    if (finalColor.a < alphaTest) {
      //discard;
    }
    
    gl_FragColor = finalColor;
}
#endif
`;
}
