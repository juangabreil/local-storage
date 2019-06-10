import fs from 'fs';
import _ from 'lodash';
import Path from 'path';
// $FlowFixMe
import async from 'async';
import mkdirp from 'mkdirp';

import LocalDriver, { noSuchFile } from './local-fs';
import { loadPrivatePackages } from './pkg-utils';

import { IPackageStorage, IPluginStorage, StorageList, LocalStorage, Logger, Config, Callback, Token, TokenFilter } from '@verdaccio/types';

const DEPRECATED_DB_NAME = '.sinopia-db.json';
const DB_NAME = '.verdaccio-db.json';

/**
 * Handle local database.
 */
class LocalDatabase implements IPluginStorage<{}> {
  public version?: string | undefined;
  public path: string;
  public logger: Logger;
  public data: LocalStorage;
  public config: Config;
  public locked: boolean;

  /**
   * Load an parse the local json database.
   * @param {*} path the database path
   */
  public constructor(config: Config, logger: Logger) {
    this.config = config;
    this.path = this._buildStoragePath(config);
    this.logger = logger;
    this.locked = false;
    this.data = this._fetchLocalPackages();
    this._sync();
  }

  public getSecret(): Promise<string> {
    return Promise.resolve(this.data.secret);
  }

  public setSecret(secret: string): Promise<Error | null> {
    return new Promise(resolve => {
      this.data.secret = secret;
      resolve(this._sync());
    });
  }

  /**
   * Add a new element.
   * @param {*} name
   * @return {Error|*}
   */
  public add(name: string, cb: Callback): void {
    if (this.data.list.indexOf(name) === -1) {
      this.data.list.push(name);
      cb(this._sync());
    } else {
      cb(null);
    }
  }

  public search(onPackage: Callback, onEnd: Callback, validateName: (name: string) => boolean): void {
    const storages = this._getCustomPackageLocalStorages();
    this.logger.trace(`local-storage: [search]: ${JSON.stringify(storages)}`);
    const base = Path.dirname(this.config.self_path);
    const self = this;
    const storageKeys = Object.keys(storages);
    this.logger.trace(`local-storage: [search] base: ${base} keys ${storageKeys}`);

    async.eachSeries(
      storageKeys,
      function(storage, cb) {
        const position = storageKeys.indexOf(storage);
        const base2 = Path.join(position !== 0 ? storageKeys[0] : '');
        const storagePath: string = Path.resolve(base, base2, storage);
        self.logger.trace({ storagePath, storage }, 'local-storage: [search] search path: @{storagePath} : @{storage}');
        fs.readdir(storagePath, (err, files) => {
          if (err) {
            return cb(err);
          }

          async.eachSeries(
            files,
            function(file, cb) {
              self.logger.trace({ file }, 'local-storage: [search] search file path: @{file}');
              if (storageKeys.includes(file)) {
                return cb();
              }

              if (file.match(/^@/)) {
                // scoped
                const fileLocation = Path.resolve(base, storage, file);
                self.logger.trace({ fileLocation }, 'local-storage: [search] search scoped file location: @{fileLocation}');
                fs.readdir(fileLocation, function(err, files) {
                  if (err) {
                    return cb(err);
                  }

                  async.eachSeries(
                    files,
                    (file2, cb) => {
                      if (validateName(file2)) {
                        const packagePath = Path.resolve(base, storage, file, file2);

                        fs.stat(packagePath, (err, stats) => {
                          if (_.isNil(err) === false) {
                            return cb(err);
                          }
                          const item = {
                            name: `${file}/${file2}`,
                            path: packagePath,
                            time: stats.mtime.getTime()
                          };
                          onPackage(item, cb);
                        });
                      } else {
                        cb();
                      }
                    },
                    cb
                  );
                });
              } else if (validateName(file)) {
                const base2 = Path.join(position !== 0 ? storageKeys[0] : '');
                const packagePath = Path.resolve(base, base2, storage, file);
                self.logger.trace({ packagePath }, 'local-storage: [search] search file location: @{packagePath}');
                fs.stat(packagePath, (err, stats) => {
                  if (_.isNil(err) === false) {
                    return cb(err);
                  }
                  onPackage(
                    {
                      name: file,
                      path: packagePath,
                      time: self._getTime(stats.mtime.getTime(), stats.mtime)
                    },
                    cb
                  );
                });
              } else {
                cb();
              }
            },
            cb
          );
        });
      },
      onEnd
    );
  }

  private _getTime(time: number, mtime: Date): number | Date {
    return time ? time : mtime;
  }

  private _getCustomPackageLocalStorages(): object {
    const storages = {};

    // add custom storage if exist
    if (this.config.storage) {
      storages[this.config.storage] = true;
    }

    const { packages } = this.config;

    if (packages) {
      const listPackagesConf = Object.keys(packages || {});

      listPackagesConf.map(pkg => {
        const storage = packages[pkg].storage;
        if (storage) {
          storages[storage] = false;
        }
      });
    }

    return storages;
  }

  /**
   * Remove an element from the database.
   * @param {*} name
   * @return {Error|*}
   */
  public remove(name: string, cb: Callback): void {
    this.get((err, data) => {
      if (err) {
        cb(new Error('error on get'));
      }

      const pkgName = data.indexOf(name);
      if (pkgName !== -1) {
        this.data.list.splice(pkgName, 1);
      }

      cb(this._sync());
    });
  }

  /**
   * Return all database elements.
   * @return {Array}
   */
  public get(cb: Callback): void {
    cb(null, this.data.list);
  }

  /**
   * Syncronize {create} database whether does not exist.
   * @return {Error|*}
   */
  private _sync(): Error | null {
    if (this.locked) {
      this.logger.error('Database is locked, please check error message printed during startup to prevent data loss.');
      return new Error('Verdaccio database is locked, please contact your administrator to checkout logs during verdaccio startup.');
    }
    // Uses sync to prevent ugly race condition
    try {
      mkdirp.sync(Path.dirname(this.path));
    } catch (err) {
      // perhaps a logger instance?
      return null;
    }

    try {
      fs.writeFileSync(this.path, JSON.stringify(this.data));
      return null;
    } catch (err) {
      return err;
    }
  }

  public getPackageStorage(packageName: string): IPackageStorage {
    const packageAccess = this.config.getMatchedPackagesSpec(packageName);

    const packagePath: string = this._getLocalStoragePath(packageAccess ? packageAccess.storage : undefined);

    if (_.isString(packagePath) === false) {
      this.logger.debug({ name: packageName }, 'this package has no storage defined: @{name}');
      return;
    }

    const packageStoragePath: string = Path.join(Path.resolve(Path.dirname(this.config.self_path || ''), packagePath), packageName);

    return new LocalDriver(packageStoragePath, this.logger);
  }

  /**
   * Verify the right local storage location.
   * @param {String} path
   * @return {String}
   * @private
   */
  private _getLocalStoragePath(storage: string | void): string {
    const globalConfigStorage = this.config ? this.config.storage : undefined;
    if (_.isNil(globalConfigStorage)) {
      throw new Error('global storage is required for this plugin');
    } else {
      if (_.isNil(storage) === false && _.isString(storage)) {
        return Path.join(globalConfigStorage as string, storage as string);
      }

      return globalConfigStorage as string;
    }
  }

  /**
   * Build the local database path.
   * @param {Object} config
   * @return {string|String|*}
   * @private
   */
  private _buildStoragePath(config: Config): string {
    const dbGenPath = function(dbName: string): string {
      return Path.join(Path.resolve(Path.dirname(config.self_path || ''), config.storage as string, dbName));
    };

    const sinopiadbPath: string = dbGenPath(DEPRECATED_DB_NAME);
    if (fs.existsSync(sinopiadbPath)) {
      return sinopiadbPath;
    }

    return dbGenPath(DB_NAME);
  }

  /**
   * Fetch local packages.
   * @private
   * @return {Object}
   */
  private _fetchLocalPackages(): LocalStorage {
    const list: StorageList = [];
    const emptyDatabase = { list, secret: '' };

    try {
      const db = loadPrivatePackages(this.path, this.logger);

      return db;
    } catch (err) {
      // readFileSync is platform specific, macOS, Linux and Windows thrown an error
      // Only recreate if file not found to prevent data loss
      if (err.code !== noSuchFile) {
        this.locked = true;
        this.logger.error('Failed to read package database file, please check the error printed below:\n', `File Path: ${this.path}\n\n ${err.message}`);
      }

      return emptyDatabase;
    }
  }

  public clean() {
    this._sync();
  }

  public saveToken(token: Token): Promise<Token> {
    throw new Error('Method not implemented.');
  }

  public deleteToken(user: string, tokenKey: string): Promise<Token> {
    throw new Error('Method not implemented.');
  }

  public readTokens(filter: TokenFilter): Promise<Token[]> {
    throw new Error('Method not implemented.');
  }
}

export default LocalDatabase;
