import { CommonModule } from '@angular/common';
import { Component, ElementRef, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';

type CheckStatus = 'ok' | 'warn' | 'error';

interface CheckResult {
  label: string;
  status: CheckStatus;
  statusLabel: string;
  detail: string;
}

@Component({
  standalone: true,
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent {
  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;

  title = 'Data Curation Checker';
  inputText = '';
  selectedFile: File | null = null;
  selectedFileName = '';
  selectedFileSize = '';
  checkResults: CheckResult[] = [];

  get hasInput(): boolean {
    return Boolean(this.selectedFile || this.inputText.trim());
  }

  handleFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    this.selectedFile = file;
    this.selectedFileName = file?.name ?? '';
    this.selectedFileSize = file ? this.formatBytes(file.size) : '';
  }

  clearFile(): void {
    this.selectedFile = null;
    this.selectedFileName = '';
    this.selectedFileSize = '';
    if (this.fileInput?.nativeElement) {
      this.fileInput.nativeElement.value = '';
    }
  }

  async runCheck(): Promise<void> {
    if (!this.hasInput) {
      this.checkResults = [];
      return;
    }

    const source = this.selectedFile ? 'File' : 'Text';
    const content = this.selectedFile
      ? await this.selectedFile.text()
      : this.inputText;

    const trimmed = content.trim();
    const lines = trimmed ? trimmed.split(/\r?\n/).length : 0;
    const emptyLines = content.split(/\r?\n/).filter((line) => !line.trim()).length;
    const delimiter = this.detectDelimiter(content);
    const headerValues = delimiter
      ? content.split(/\r?\n/)[0]?.split(delimiter).map((value) => value.trim())
      : [];
    const duplicateHeaders = this.countDuplicates(headerValues);

    this.checkResults = [
      {
        label: 'Source',
        status: 'ok',
        statusLabel: 'OK',
        detail: `${source} detected${this.selectedFileName ? `: ${this.selectedFileName}` : ''}.`
      },
      {
        label: 'Lines',
        status: lines > 0 ? 'ok' : 'warn',
        statusLabel: lines > 0 ? 'OK' : 'Notice',
        detail: lines > 0 ? `${lines} lines found.` : 'No lines detected.'
      },
      {
        label: 'Delimiter',
        status: delimiter ? 'ok' : 'warn',
        statusLabel: delimiter ? 'OK' : 'Notice',
        detail: delimiter
          ? `Delimiter "${delimiter}" detected.`
          : 'No clear delimiter detected.'
      },
      {
        label: 'Empty lines',
        status: emptyLines > 0 ? 'warn' : 'ok',
        statusLabel: emptyLines > 0 ? 'Notice' : 'OK',
        detail: emptyLines > 0
          ? `${emptyLines} empty lines found.`
          : 'No empty lines found.'
      },
      {
        label: 'Header',
        status: duplicateHeaders > 0 ? 'warn' : 'ok',
        statusLabel: duplicateHeaders > 0 ? 'Notice' : 'OK',
        detail: duplicateHeaders > 0
          ? `${duplicateHeaders} duplicate header(s) detected.`
          : 'No duplicate headers found.'
      }
    ];
  }

  private detectDelimiter(content: string): string | null {
    const firstLine = content.split(/\r?\n/)[0] ?? '';
    const candidates = [',', ';', '\t', '|'];
    const scores = candidates.map((symbol) => ({
      symbol,
      count: firstLine.split(symbol).length - 1
    }));
    const best = scores.sort((a, b) => b.count - a.count)[0];
    return best.count > 0 ? best.symbol : null;
  }

  private countDuplicates(values: string[]): number {
    if (!values.length) {
      return 0;
    }
    const seen = new Set<string>();
    let duplicates = 0;
    values.forEach((value) => {
      if (!value) {
        return;
      }
      if (seen.has(value)) {
        duplicates += 1;
      } else {
        seen.add(value);
      }
    });
    return duplicates;
  }

  private formatBytes(bytes: number): string {
    if (!bytes) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = bytes / Math.pow(1024, index);
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
  }
}
