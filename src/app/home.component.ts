import { Component, ElementRef, ViewChild } from '@angular/core';
import { Router } from '@angular/router';

import { SourceStoreService } from './source-store.service';

@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.css'],
})
export class HomeComponent {
  @ViewChild('imageFilesInput') private imageFilesInput?: ElementRef<HTMLInputElement>;

  isLoading = false;
  errorMessage = '';
  sourceFolderName = 'no folder selected';
  hasPersistedSource = false;

  constructor(private readonly sourceStore: SourceStoreService, private readonly router: Router) {
    void this.loadSourceName();
  }

  get supportsDirectoryPicker(): boolean {
    return this.sourceStore.supportsDirectoryPicker;
  }

  async chooseSource(): Promise<void> {
    this.errorMessage = '';
    if (!this.supportsDirectoryPicker) {
      this.router.navigate(['/selection']);
      return;
    }

    try {
      this.isLoading = true;
      const handle = await this.sourceStore.getDirectoryPicker()();
      await this.sourceStore.persistSourceFolder(handle);
      this.sourceFolderName = handle.name;
      await this.router.navigate(['/selection']);
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Unable to open source folder.';
    } finally {
      this.isLoading = false;
    }
  }

  onFilesChosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) {
      return;
    }
    this.sourceFolderName = 'manual files';
    input.value = '';
    void this.router.navigate(['/selection']);
  }

  async continueWithStoredSource(): Promise<void> {
    await this.router.navigate(['/selection']);
  }

  private async loadSourceName(): Promise<void> {
    try {
      const persisted = await this.sourceStore.getPersistedSourceHandle();
      this.sourceFolderName = persisted.name;
      this.hasPersistedSource = Boolean(persisted.handle);
    } catch {
      this.sourceFolderName = 'no folder selected';
      this.hasPersistedSource = false;
    }
  }
}
