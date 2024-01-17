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

// FIXME this is a memory leak
let _fileCache: Map<number, any> = new Map();
export async function fetchFileByID<T>(fileId: number, dataFetcher: DataFetcher, constructor: Constructor<T>): Promise<T> {
  if (_fileCache.has(fileId)) {
    return _fileCache.get(fileId);
  }
  const buf = await fetchDataByFileID(fileId, dataFetcher);
  const file = constructor(buf);
  _fileCache.set(fileId, file);
  return file;
}

let _fetchedIds: {[key: number]: number} = {};
export async function fetchDataByFileID(fileId: number, dataFetcher: DataFetcher): Promise<Uint8Array> {
  if (fileId in _fetchedIds) {
    console.log(`dupe fetch (${_fetchedIds[fileId]} ${getFilePath(fileId)})`)
    _fetchedIds[fileId]++;
  } else {
    _fetchedIds[fileId] = 1;
  }
  const filePath = getFilePath(fileId);
  const buf = await dataFetcher.fetchData(`/wow/${filePath}`);
  return buf.createTypedArray(Uint8Array);
}
