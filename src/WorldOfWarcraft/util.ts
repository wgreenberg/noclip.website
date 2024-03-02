import { DataFetcher } from "../DataFetcher.js";

class FileList {
    public files: string[] | undefined;

    constructor() {
    }

    public async load(dataFetcher: DataFetcher) {
      const decoder = new TextDecoder();
      const fileListData = await dataFetcher.fetchData(`wow/listfile.csv`);
      const files: string[] = [];
      decoder.decode(fileListData.createTypedArray(Uint8Array)).split('\r\n').forEach(line => {
        const [idxStr, fileName] = line.split(';');
        const idx = parseInt(idxStr);
        files[idx] = fileName;
      })
      this.files = files;
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

export type Constructor<T> = (data: Uint8Array) => T;

export async function fetchFileByID<T>(fileId: number, dataFetcher: DataFetcher, constructor: Constructor<T>): Promise<T> {
  const buf = await fetchDataByFileID(fileId, dataFetcher);
  return constructor(buf);
}

export async function fetchDataByFileID(fileId: number, dataFetcher: DataFetcher): Promise<Uint8Array> {
  const filePath = getFilePath(fileId);
  const buf = await dataFetcher.fetchData(`/wotlk/${filePath}`);
  return buf.createTypedArray(Uint8Array);
}
