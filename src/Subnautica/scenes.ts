import * as Viewer from '../viewer';
import { DeviceProgram } from '../Program';
import { SceneContext } from '../SceneBase';
import { fillMatrix4x4 } from '../gfx/helpers/UniformBufferHelpers';
import { GfxDevice, GfxBufferUsage, GfxBuffer, GfxInputState, GfxFormat, GfxInputLayout, GfxProgram, GfxBindingLayoutDescriptor, GfxVertexBufferFrequency, GfxVertexAttributeDescriptor, GfxInputLayoutBufferDescriptor, GfxCullMode } from '../gfx/platform/GfxPlatform';
import { makeBackbufferDescSimple, pushAntialiasingPostProcessPass, standardFullClearRenderPassDescriptor } from '../gfx/helpers/RenderGraphHelpers';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph';
import { GfxRenderInstManager } from '../gfx/render/GfxRenderInstManager';
import { makeStaticDataBuffer } from '../gfx/helpers/BufferHelpers';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper';

class ChunkProgram extends DeviceProgram {
    public static a_Position = 0;
    public static a_Normal = 1;
    public static a_Index = 2;

    public static ub_SceneParams = 0;

    public override both = `
precision mediump float;

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
    Mat4x4 u_ModelView;
};

varying vec2 v_LightIntensity;

#ifdef VERT
layout(location = ${ChunkProgram.a_Position}) attribute vec3 a_Position;
layout(location = ${ChunkProgram.a_Normal}) attribute vec3 a_Normal;

void mainVS() {
    const float t_ModelScale = 20.0;
    gl_Position = Mul(u_Projection, Mul(u_ModelView, vec4(a_Position * t_ModelScale, 1.0)));
    vec3 t_LightDirection = normalize(vec3(.2, -1, .5));
    vec3 normal = normalize(a_Normal);
    float t_LightIntensityF = dot(-normal, t_LightDirection);
    float t_LightIntensityB = dot( normal, t_LightDirection);
    v_LightIntensity = vec2(t_LightIntensityF, t_LightIntensityB);
}
#endif

#ifdef FRAG
void mainPS() {
    vec4 color = vec4(.4, .4, .4, 1.0);
    float t_LightIntensity = gl_FrontFacing ? v_LightIntensity.x : v_LightIntensity.y;
    float t_LightTint = 0.5 * t_LightIntensity;
    gl_FragColor = sqrt(color + vec4(t_LightTint, t_LightTint, t_LightTint, 0.0));
}
#endif
`;
}

// big blocky scaley
const CHUNK_SCALE = 32;

class MeshRenderer {
    public normsBuf: GfxBuffer;
    public vertsBuf: GfxBuffer;
    public trisBuf: GfxBuffer;
    public inputState: GfxInputState;
    public numVertices: number;

    constructor(device: GfxDevice, mesh: Mesh, public offset: Vertex, public inputLayout: GfxInputLayout) {
        for (let i=0; i<mesh.vertices.length; i += 3) {
            mesh.vertices[i+0] += offset.x;
            mesh.vertices[i+1] += offset.y;
            mesh.vertices[i+2] += offset.z;
        }

        this.vertsBuf = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, mesh.vertices.buffer);
        this.normsBuf = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, mesh.normals.buffer);
        this.trisBuf = makeStaticDataBuffer(device, GfxBufferUsage.Index, mesh.indices.buffer);

        this.inputState = device.createInputState(inputLayout, [
            { buffer: this.vertsBuf, byteOffset: 0, },
            { buffer: this.normsBuf, byteOffset: 0, },
        ], { buffer: this.trisBuf, byteOffset: 0 });
        this.numVertices = mesh.indices.length;
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager): void {
        const renderInst = renderInstManager.newRenderInst();
        renderInst.setInputLayoutAndState(this.inputLayout, this.inputState);
        renderInst.drawIndexes(this.numVertices);
        renderInstManager.submitRenderInst(renderInst);
    }

    public destroy(device: GfxDevice) {
        device.destroyBuffer(this.normsBuf);
        device.destroyBuffer(this.trisBuf);
        device.destroyBuffer(this.vertsBuf);
        device.destroyInputState(this.inputState);
    }
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 1, numSamplers: 0 }, // ub_SceneParams
];

class Mesh {
    vertices: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
}

class SubnauticaRenderer implements Viewer.SceneGfx {
    public inputState: GfxInputState;
    private inputLayout: GfxInputLayout;
    private meshRenderers: MeshRenderer[];
    private renderHelper: GfxRenderHelper;
    public program: GfxProgram;

    constructor(public device: GfxDevice) {
        this.program = device.createProgram(new ChunkProgram());
        this.inputLayout = this.createInputLayout(device);
        this.meshRenderers = [];
    }

    addMesh(mesh: Mesh, offset: Vertex) {
        this.meshRenderers.push(new MeshRenderer(this.device, mesh, offset, this.inputLayout));
    }

    createInputLayout(device: GfxDevice): GfxInputLayout {
        const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
            { location: ChunkProgram.a_Position, bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_RGB, },
            { location: ChunkProgram.a_Normal,   bufferIndex: 1, bufferByteOffset: 0, format: GfxFormat.F32_RGB, },
        ];
        const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
            { byteStride: 3*0x04, frequency: GfxVertexBufferFrequency.PerVertex, },
            { byteStride: 3*0x04, frequency: GfxVertexBufferFrequency.PerVertex, },
        ];
        const indexBufferFormat: GfxFormat = GfxFormat.U32_R;
        this.renderHelper = new GfxRenderHelper(device);
        return device.createInputLayout({ vertexAttributeDescriptors, vertexBufferDescriptors, indexBufferFormat });
    }

    private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(bindingLayouts);
        template.setGfxProgram(this.program);
        //template.setMegaStateFlags({ cullMode: GfxCullMode.Back });

        let offs = template.allocateUniformBuffer(ChunkProgram.ub_SceneParams, 32);
        const mapped = template.mapUniformBufferF32(ChunkProgram.ub_SceneParams);
        offs += fillMatrix4x4(mapped, offs, viewerInput.camera.projectionMatrix);
        offs += fillMatrix4x4(mapped, offs, viewerInput.camera.viewMatrix);

        for (let i = 0; i < this.meshRenderers.length; i++)
            this.meshRenderers[i].prepareToRender(this.renderHelper.renderInstManager);

        this.renderHelper.renderInstManager.popTemplateRenderInst();
        this.renderHelper.prepareToRender();
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
        const renderInstManager = this.renderHelper.renderInstManager;

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
        device.destroyInputLayout(this.inputLayout);
        device.destroyProgram(this.program);
        this.meshRenderers.forEach((r) => r.destroy(device));
        this.renderHelper.destroy();
    }
}

class Vertex {
    x: number;
    y: number;
    z: number;
}

function parseChunkId(chunkId: string): Vertex {
    let bits = chunkId.split('-');
    return {
        x: parseInt(bits[1]) * CHUNK_SCALE,
        y: parseInt(bits[2]) * CHUNK_SCALE,
        z: parseInt(bits[3]) * CHUNK_SCALE,
    }
}

class ChunkInfo {
    name: string,
    idx: number,
}

class SubnauticaSceneDesc implements Viewer.SceneDesc {
    private inputLayout: GfxInputLayout;

    constructor(public id: string, public name: string) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const { MeshDatabase } = await import("../../rust/pkg/index");
        const renderer = new SubnauticaRenderer(device);
        const decoder = new TextDecoder();
        let chunks: ChunkInfo[] = [];
        let db = await context.dataFetcher.fetchData(`subnautica/resources.assets`)
            .then(chunk => {
                let db = MeshDatabase.new(new Uint8Array(chunk.arrayBuffer))
                db.read();
                for (let i=0; i<db.count_meshes(); i++) {
                    let name = db.get_mesh_name(i);
                    if (name.startsWith('Chunk')) {
                        chunks.push({ name: name, idx: i });
                    }
                }
                return db;
            });

        function loadChunk() {
            let info: ChunkInfo | undefined = chunks.shift();
            if (info === undefined) {
                return false;
            }
            let offset = parseChunkId(info.name);
            let chunk: any = db.load_mesh(info.idx);
            try {
                let mesh: Mesh = {
                    vertices: chunk.get_vertices(),
                    normals: chunk.get_normals(),
                    indices: chunk.get_indices(),
                };
                renderer.addMesh(mesh, offset);
            } catch (e) {
                // TODO fix uncompressed meshes
                console.log(`couldn't load mesh: ${e}`);
            }
            return true;
        }

        function loadChunks() {
            for (let i=0; i<3; i++) {
                if (!loadChunk()) {
                    return;
                }
            }
            setTimeout(loadChunks, 0);
        }

        loadChunks();

        return renderer;
    }

}

const id = 'Subnautica';
const name = 'Subnautica';

const sceneDescs = [
    new SubnauticaSceneDesc("Scanner Map", "Scanner Map"),
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs };