# Utilities Directory

This directory contains various utility scripts that have been organized for better maintainability. These scripts were previously in the root directory and have been moved here to reduce clutter.

## Organization

The utilities are organized into the following subdirectories:

### `scripts/`
General utility scripts for various purposes, including:
- Bot configuration forms
- Server utilities

### `scripts/close-commands/`
Scripts related to closing tickets, often providing alternative methods for ticket closing:
- Direct close commands (bypassing the bot framework)
- Emergency closing utilities
- Force close commands
- Standalone close bots

### `scripts/debug/`
Debugging utilities for troubleshooting issues:
- Bot command debugging
- Telegram message debugging
- Server debugging
- Raw message monitoring

### `scripts/test/`
Test scripts for verifying functionality:
- Ticket creation tests
- Command testing
- User state persistence tests
- Image upload tests

### `backup/`
Backup files that have been preserved for reference.

## Usage

These scripts are primarily for development, debugging, and emergency scenarios. Most of them can be run with Node.js and may accept command-line parameters.

Example usage:
```
node utilities/scripts/test/test-user-state.js [telegramId]
```

## Notes

- These scripts are not part of the main application flow
- They are useful for troubleshooting and debugging specific issues
- Some scripts might be obsolete or superseded by newer implementations
- Use with caution, especially scripts that modify database records directly