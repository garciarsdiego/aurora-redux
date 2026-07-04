export interface VaultEntry {
  path: string;
  content: string;
  contentType: string;
  createdAt: number;
  updatedAt: number;
  sizeBytes: number;
}

export interface VaultIndex {
  [path: string]: {
    contentType: string;
    createdAt: number;
    updatedAt: number;
    sizeBytes: number;
  };
}
