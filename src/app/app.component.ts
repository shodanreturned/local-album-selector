import { Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';

type DirectoryHandle = FileSystemDirectoryHandle;
type FileHandle = FileSystemFileHandle;

interface AlbumImage {
  id: string;
  name: string;
  url: string;
  file: File;
  handle: FileHandle | null;
  selected: boolean;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
})
export class AppComponent implements OnDestroy {
  @ViewChild('imageFilesInput') private imageFilesInput?: ElementRef<HTMLInputElement>;

  private readonly batchSize = 80;
  private readonly longPressMs = 450;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private activePressImageId: string | null = null;
  private longPressImageId: string | null = null;
  private destinationHandle: DirectoryHandle | null = null;

  allImages: AlbumImage[] = [];
  visibleCount = this.batchSize;
  isLoading = false;
  errorMessage = '';
  isSelectingDestination = false;
  showSelectedOnly = false;
  fullscreenImageUrl: string | null = null;
  fullscreenImageName = '';

  get supportsDirectoryPicker(): boolean {
    return 'showDirectoryPicker' in window;
  }

  get selectedCount(): number {
    return this.allImages.filter((image) => image.selected).length;
  }

  get filteredImages(): AlbumImage[] {
    const source = this.showSelectedOnly
      ? this.allImages.filter((image) => image.selected)
      : this.allImages;
    return source.slice(0, this.visibleCount);
  }

  get canLoadMore(): boolean {
    const max = this.showSelectedOnly
      ? this.selectedCount
      : this.allImages.length;
    return this.visibleCount < max;
  }

  ngOnDestroy(): void {
    this.revokeAllUrls();
  }

  async pickDirectory(): Promise<void> {
    this.errorMessage = '';
    if (!this.supportsDirectoryPicker) {
      this.imageFilesInput?.nativeElement.click();
      return;
    }

    try {
      this.isLoading = true;
      this.showSelectedOnly = false;
      this.visibleCount = this.batchSize;
      this.revokeAllUrls();
      this.allImages = [];
      this.destinationHandle = null;

      const rootHandle = await this.getDirectoryPicker()();
      const fileHandles = await this.collectImageHandles(rootHandle);

      this.allImages = await Promise.all(
        fileHandles.map(async (handle, index) => {
          const file = await handle.getFile();
          return {
            id: `${index}-${file.name}`,
            name: file.name,
            url: URL.createObjectURL(file),
            file,
            handle,
            selected: false,
          };
        }),
      );
      this.allImages.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    } catch (error) {
      this.errorMessage = this.readError(error, 'Unable to open folder.');
    } finally {
      this.isLoading = false;
    }
  }

  onFilesChosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (!files.length) {
      return;
    }

    this.errorMessage = '';
    this.showSelectedOnly = false;
    this.visibleCount = this.batchSize;
    this.revokeAllUrls();
    this.destinationHandle = null;

    this.allImages = files
      .filter((file) => {
        const lower = file.name.toLowerCase();
        return lower.endsWith('.jpg') || lower.endsWith('.jpeg');
      })
      .map((file, index) => ({
        id: `${index}-${file.name}`,
        name: file.name,
        url: URL.createObjectURL(file),
        file,
        handle: null,
        selected: false,
      }));

    this.allImages.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    input.value = '';
  }

  onGridScroll(event: Event): void {
    const element = event.target as HTMLElement;
    const nearBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 200;
    if (nearBottom && this.canLoadMore) {
      this.visibleCount += this.batchSize;
    }
  }

  startPress(image: AlbumImage): void {
    this.clearPress();
    this.activePressImageId = image.id;
    this.longPressTimer = setTimeout(() => {
      this.longPressImageId = image.id;
      this.openFullscreen(image);
    }, this.longPressMs);
  }

  endPress(image: AlbumImage): void {
    if (this.activePressImageId !== image.id) {
      return;
    }

    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }

    if (this.longPressImageId !== image.id) {
      image.selected = !image.selected;
    }

    this.longPressImageId = null;
    this.activePressImageId = null;
  }

  cancelPress(): void {
    this.clearPress();
  }

  toggleSelectedOnly(): void {
    this.showSelectedOnly = !this.showSelectedOnly;
    this.visibleCount = this.batchSize;
  }

  closeFullscreen(): void {
    this.fullscreenImageUrl = null;
    this.fullscreenImageName = '';
  }

  async finaliseSelection(): Promise<void> {
    this.errorMessage = '';
    const selected = this.allImages.filter((image) => image.selected);
    if (!selected.length) {
      this.errorMessage = 'Select at least one image before finalising.';
      return;
    }

    if (!this.supportsDirectoryPicker) {
      this.downloadSelectedImages(selected);
      return;
    }

    try {
      this.isSelectingDestination = true;
      if (!this.destinationHandle) {
        this.destinationHandle = await this.getDirectoryPicker()();
      }

      for (const image of selected) {
        const sourceFile = image.handle ? await image.handle.getFile() : image.file;
        const targetHandle = await this.destinationHandle.getFileHandle(sourceFile.name, { create: true });
        const writable = await (
          targetHandle as unknown as { createWritable: () => Promise<{ write: (data: ArrayBuffer) => Promise<void>; close: () => Promise<void> }> }
        ).createWritable();
        await writable.write(await sourceFile.arrayBuffer());
        await writable.close();
      }
    } catch (error) {
      this.errorMessage = this.readError(error, 'Unable to copy selected images.');
    } finally {
      this.isSelectingDestination = false;
    }
  }

  private openFullscreen(image: AlbumImage): void {
    this.fullscreenImageUrl = image.url;
    this.fullscreenImageName = image.name;
  }

  private clearPress(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.longPressImageId = null;
    this.activePressImageId = null;
  }

  private async collectImageHandles(directory: DirectoryHandle): Promise<FileHandle[]> {
    const images: FileHandle[] = [];

    const walk = async (folder: DirectoryHandle): Promise<void> => {
      const directoryEntries = folder as unknown as AsyncIterable<[string, FileSystemHandle]>;
      for await (const [, handle] of directoryEntries) {
        if (handle.kind === 'directory') {
          await walk(handle as DirectoryHandle);
          continue;
        }

        const fileHandle = handle as FileHandle;
        const lower = fileHandle.name.toLowerCase();
        if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
          images.push(fileHandle);
        }
      }
    };

    await walk(directory);
    return images;
  }

  private revokeAllUrls(): void {
    for (const image of this.allImages) {
      URL.revokeObjectURL(image.url);
    }
  }

  private readError(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return fallback;
  }

  private downloadSelectedImages(selected: AlbumImage[]): void {
    for (const image of selected) {
      const link = document.createElement('a');
      link.href = image.url;
      link.download = image.name;
      link.click();
    }
  }

  private getDirectoryPicker(): () => Promise<DirectoryHandle> {
    return (window as unknown as { showDirectoryPicker: () => Promise<DirectoryHandle> }).showDirectoryPicker;
  }
}
