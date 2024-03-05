import { DataFetcher } from "../DataFetcher.js";

class FileList {
    public files: string[] = [];
    public fileIds: Map<string, number> = new Map();

    constructor() {
    }

    public async load(dataFetcher: DataFetcher) {
      const decoder = new TextDecoder();
      const fileListData = await dataFetcher.fetchData(`wow/listfile.csv`);
      decoder.decode(fileListData.createTypedArray(Uint8Array)).split('\r\n').forEach(line => {
        const [idxStr, fileName] = line.split(';');
        if (idxStr === undefined || fileName === undefined) return;
        const idx = parseInt(idxStr);
        const normalizedFileName = this.normalizeFileName(fileName);
        this.files[idx] = normalizedFileName;
        this.fileIds.set(normalizedFileName, idx);
      })
    }

    private normalizeFileName(fileName: string): string {
      return fileName.replaceAll('\\', '/').toLowerCase();
    }

    public getFilename(fileId: number): string {
      if (!this.files) {
        throw new Error(`must load FileList first`);
      }
      const filePath = this.files[fileId];
      if (!filePath) {
        throw new Error(`couldn't find path for fileId ${fileId}`);
      }
      return filePath;
    }

    public getFileDataId(fileName: string): number | undefined {
      return this.fileIds.get(this.normalizeFileName(fileName));
    }
}

let _fileList: FileList | undefined = undefined;
export async function initFileList(dataFetcher: DataFetcher): Promise<undefined> {
  if (!_fileList) {
    _fileList = new FileList();
    await _fileList.load(dataFetcher);
  }
}

export function getFilePath(fileId: number): string {
  return _fileList!.getFilename(fileId);
}

export function getFileDataId(fileName: string): number | undefined {
  const result = _fileList!.getFileDataId(fileName);
  if (result === undefined && fileName !== '') {
    console.warn(`failed to find FileDataId for fileName ${fileName}`);
  }
  return result;
}

export type Constructor<T> = (data: Uint8Array) => T;

export async function fetchFileByID<T>(fileId: number, dataFetcher: DataFetcher, constructor: Constructor<T>): Promise<T> {
  const buf = await fetchDataByFileID(fileId, dataFetcher);
  return constructor(buf);
}

export async function fetchDataByFileID(fileId: number, dataFetcher: DataFetcher): Promise<Uint8Array> {
  const filePath = getFilePath(fileId);
  // WOTLK extraction is from build 3.4.3.52237
  // Vanilla extraction is from build 1.5.1.53495
  const buf = await dataFetcher.fetchData(`/wotlk/${filePath}`);
  return buf.createTypedArray(Uint8Array);
}
