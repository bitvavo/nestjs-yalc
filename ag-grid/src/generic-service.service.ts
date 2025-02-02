import { ConditionsTooBroadError, NoResultsFoundError } from './conditions.error';
import { CreateEntityError, DeleteEntityError, EntityError, UpdateEntityError } from './entity.error';
import { getConnectionName } from '@nestjs-yalc/database/conn.helper';
import { FactoryProvider, Injectable } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EntityClassOrSchema } from '@nestjs/typeorm/dist/interfaces/entity-class-or-schema.type';
import { DeepPartial, FindConditions, FindManyOptions, getConnection, ObjectLiteral, QueryFailedError } from 'typeorm';
import { AgGridRepository } from '@nestjs-yalc/ag-grid/ag-grid.repository';
import { AgGridFindManyOptions } from '@nestjs-yalc/ag-grid/ag-grid.interface';
import { ClassType } from '@nestjs-yalc/types/globals';
import { getProviderToken } from './ag-grid.helpers';
import { ReplicationMode } from '@nestjs-yalc/database/query-builder.helper';
import { isClass } from '@nestjs-yalc/utils/class.helper';
import { getAgGridFieldMetadataList, isDstExtended } from './object.decorator';
import { UpsertOptions } from 'typeorm/repository/UpsertOptions';

/**
 *
 * @todo must be refactorized with better types
 *
 * Factory function, creates a Provider for the specified Service class, entity and connection
 * @param providedClass Service Class name or Type
 * @param entity TypeORM Entity
 * @param connectionName The Database connection name
 */
export function GenericServiceFactory<Entity>(
  entity: EntityClassOrSchema,
  connectionName: string,
  providedClass?: ClassType<GenericService<Entity>>,
  entityWrite?: EntityClassOrSchema,
  connectionNameWrite?: string,
): FactoryProvider {
  const serviceClass = providedClass ?? GenericService;

  return {
    provide:
      providedClass ??
      getServiceToken(
        typeof entity === 'function' ? entity.name : entity.toString(),
      ),
    useFactory: (
      repository: AgGridRepository<any>,
      repositoryWrite: AgGridRepository<any>,
    ) => {
      return new serviceClass(repository, repositoryWrite);
    },
    inject: [
      getRepositoryToken(entity, connectionName),
      getRepositoryToken(
        entityWrite ?? entity,
        connectionNameWrite ?? connectionName,
      ),
    ],
  };
}

export function getServiceToken(entity: ClassType | string) {
  return `${getProviderToken(entity)}GenericService`;
}

/**
 * Validates if the error generated is related to the TypeORM Create/Update/Delete operation and re-throw it as a custom error.
 * @param errorClass The custom error class to throw
 * @throws EntityError
 */
export function validateSupportedError(
  errorClass: new (error: Error) => EntityError,
) {
  return (error: Error) => {
    if (error instanceof QueryFailedError) {
      throw new errorClass(error);
    }
    throw error;
  };
}

/**
 * @todo must be refactorized with better types
 */
@Injectable()
export class GenericService<EntityRead, EntityWrite = EntityRead> {
  protected entityRead: EntityClassOrSchema;
  protected entityWrite: EntityClassOrSchema;
  protected repositoryWrite: AgGridRepository<EntityWrite>;

  /**
   *
   * @param repositoryRead the main repository, if you do not specify the repositoryWrite it is used as write repository too
   * @param repositoryWrite specify this repository when you have to write on another entity, this is useful when you read from a view but you
   * need to write on another source
   */
  constructor(
    protected repository: AgGridRepository<EntityRead>,
    repositoryWrite?: AgGridRepository<EntityWrite>,
  ) {
    this.repositoryWrite =
      repositoryWrite ??
      ((<unknown>this.repository) as AgGridRepository<EntityWrite>);

    // Extracts the target Entity from the AgGridRepository
    this.entityRead = this.repository.target as EntityClassOrSchema;
    this.entityWrite = this.repositoryWrite.target as EntityClassOrSchema;
  }

  /**
   * Switches this Service database connection to a new specified database
   * @param dbName The database name
   */
  public switchDatabaseConnection(dbName: string): void {
    const connectionName = getConnectionName(dbName);
    const connection = getConnection(connectionName);
    this.setRepositoryRead(
      connection.getRepository(this.entityRead) as AgGridRepository<EntityRead>,
    );

    this.setRepositoryWrite(
      connection.getRepository(
        this.entityWrite,
      ) as AgGridRepository<EntityWrite>,
    );
  }

  /**
   * Changes the Service repository (both write and read)
   * @param repository
   */
  protected setRepository(
    repository: AgGridRepository<EntityRead | EntityWrite>,
  ): void {
    this.setRepositoryRead(repository as AgGridRepository<EntityRead>);
    this.setRepositoryWrite(repository as AgGridRepository<EntityWrite>);
  }

  /**
   * Changes the Service repository for read operations
   * @param repository
   */
  protected setRepositoryRead(repository: AgGridRepository<EntityRead>): void {
    this.repository = repository;
  }

  /**
   * Changes the Service repository for read operations
   * @param repository
   */
  protected setRepositoryWrite(
    repository: AgGridRepository<EntityWrite>,
  ): void {
    this.repositoryWrite = repository;
  }

  /**
   * Returns the Service repository (read)
   */
  getRepository(): AgGridRepository<EntityRead> {
    return this.repository;
  }

  /**
   * Returns the Service repository (write)
   */
  getRepositoryWrite(): AgGridRepository<EntityWrite> {
    return this.repositoryWrite;
  }

  /**
   * Returns a List of entities based in the provided options.
   * @param findOptions Filter options
   * @param withCount whether or not the number results should be returned
   * @param relations Related entities to load as part of the results
   * @param databaseName The database name, to open a new database connection
   */
  async getEntityList(
    findOptions: FindManyOptions<EntityRead> | ObjectLiteral,
    withCount?: false,
    relations?: string[],
    databaseName?: string,
  ): Promise<EntityRead[]>;
  async getEntityList(
    findOptions: FindManyOptions<EntityRead> | ObjectLiteral,
    withCount: true,
    relations?: string[],
    databaseName?: string,
  ): Promise<[EntityRead[], number]>;
  async getEntityList(
    findOptions: FindManyOptions<EntityRead> | ObjectLiteral,
    withCount = false,
    relations?: string[],
    databaseName?: string,
  ): Promise<[EntityRead[], number] | EntityRead[]> {
    // Allows to switch to a different database connection
    if (databaseName) this.switchDatabaseConnection(databaseName);
    if (relations) findOptions.relations = relations;

    return withCount
      ? this.repository.findAndCount(findOptions)
      : this.repository.find(findOptions);
  }

  /**
   * Shortcut of getEntity with  failOnNull = true
   * @see {@link getEntity} for further information
   */
  async getEntityOrFail(
    where:
      | FindConditions<EntityRead>[]
      | FindConditions<EntityRead>
      | ObjectLiteral
      | string,
    fields?: (keyof EntityRead)[],
    relations?: string[],
    databaseName?: string,
  ): Promise<EntityRead> {
    return this.getEntity(where, fields, relations, databaseName, {
      failOnNull: true,
    });
  }

  /**
   * Returns an entity, or entity fields, based in the filters provided
   * @param where Filter options
   * @param fields Specific Entity fields to retrieve
   * @param relations Related entities to load as part of the Entity
   * @param databaseName The database name, to open a new database connection
   */
  async getEntity(
    where:
      | FindConditions<EntityRead>[]
      | FindConditions<EntityRead>
      | ObjectLiteral
      | string,
    fields?: (keyof EntityRead)[],
    relations?: string[],
    databaseName?: string,
    options?: {
      failOnNull: false;
    },
  ): Promise<EntityRead | undefined>;
  async getEntity(
    where:
      | FindConditions<EntityRead>[]
      | FindConditions<EntityRead>
      | ObjectLiteral
      | string,
    fields?: (keyof EntityRead)[],
    relations?: string[],
    databaseName?: string,
    options?: {
      failOnNull?: boolean;
    },
  ): Promise<EntityRead>;
  async getEntity(
    where:
      | FindConditions<EntityRead>[]
      | FindConditions<EntityRead>
      | ObjectLiteral
      | string,
    fields?: (keyof EntityRead)[],
    relations?: string[],
    databaseName?: string,
    options?: {
      failOnNull?: boolean;
    },
  ): Promise<EntityRead | undefined> {
    // Allows to switch to a different database connection
    if (databaseName) this.switchDatabaseConnection(databaseName);

    return options?.failOnNull !== true
      ? this.repository.findOne({ where, select: fields, relations })
      : this.repository.findOneOrFail({ where, select: fields, relations });
  }

  /**
   * Creates an entity based in the provided data and returns it
   * @param entity
   * @throws CreateEntityError
   */
  async createEntity(
    input: DeepPartial<EntityRead>,
    findOptions?: AgGridFindManyOptions<EntityRead>,
    returnEntity?: true,
  ): Promise<EntityRead>;
  async createEntity(
    input: DeepPartial<EntityRead>,
    findOptions?: AgGridFindManyOptions<EntityRead>,
    returnEntity?: boolean,
  ): Promise<EntityRead | boolean>;
  async createEntity(
    input: DeepPartial<EntityRead>,
    findOptions?: AgGridFindManyOptions<EntityRead>,
    returnEntity = true,
  ): Promise<EntityRead | boolean> {
    /**
     * This is needed to keep the prototype of the
     * entity in order to allow the beforeInsert to be executed
     */
    let entityHydrated = this.mapEntityR2W(input);
    const entity = this.entityWrite;
    if (isClass(entity)) {
      const inputValues = entityHydrated;
      entityHydrated = new entity();
      Object.assign(entityHydrated, inputValues);
    }

    const newEntity = this.repositoryWrite.create(entityHydrated);
    const { identifiers } = await this.repositoryWrite
      .insert(newEntity)
      .catch(validateSupportedError(CreateEntityError));
    /**
     * Create where condition for the identifiers
     * @todo maybe conversion is needed here as well
     */
    const ids = identifiers[0];
    const filters = this.repository.generateFilterOnPrimaryColumn(ids);

    return !returnEntity
      ? true
      : this.repository.getOneAgGrid(
          { ...findOptions, where: { filters } },
          true,
          ReplicationMode.MASTER,
        );
  }

  /**
   * Upsert an entity based in the provided data and returns it
   * @param entity
   * @throws CreateEntityError
   */
  async upsertEntity(
    input: DeepPartial<EntityRead>,
    upsertOptions: UpsertOptions<EntityRead>,
    findOptions?: AgGridFindManyOptions<EntityRead>,
    returnEntity?: true,
  ): Promise<EntityRead>;
  async upsertEntity(
    input: DeepPartial<EntityRead>,
    upsertOptions: UpsertOptions<EntityRead>,
    findOptions?: AgGridFindManyOptions<EntityRead>,
    returnEntity?: boolean,
  ): Promise<EntityRead | boolean>;
  async upsertEntity(
    input: DeepPartial<EntityRead>,
    upsertOptions: UpsertOptions<EntityRead>,
    findOptions?: AgGridFindManyOptions<EntityRead>,
    returnEntity = true,
  ): Promise<EntityRead | boolean> {
    /**
     * This is needed to keep the prototype of the
     * entity in order to allow the beforeInsert to be executed
     */
    let entityHydrated = this.mapEntityR2W(input);
    const entity = this.entityWrite;
    if (isClass(entity)) {
      const inputValues = entityHydrated;
      entityHydrated = new entity();
      Object.assign(entityHydrated, inputValues);
    }

    const newEntity = this.repositoryWrite.create(entityHydrated);
    const { identifiers } = await this.repositoryWrite
      .upsert(newEntity, upsertOptions)
      .catch(validateSupportedError(CreateEntityError));
    /**
     * Create where condition for the identifiers
     * @todo maybe conversion is needed here as well
     */
    const ids = identifiers[0];
    const filters = this.repository.generateFilterOnPrimaryColumn(ids);

    return !returnEntity
      ? true
      : this.repository.getOneAgGrid(
          { ...findOptions, where: { filters } },
          true,
          ReplicationMode.MASTER,
        );
  }

  /**
   * Updates an entity based in the provided conditions and return the updated entity
   * @param conditions The conditions to update
   * @param input The data to update
   * @throws UpdateEntityError
   * @throws NoResultsForConditions
   * @throws ConditionsTooBroadError
   */
  async updateEntity(
    conditions: FindConditions<EntityRead>,
    input: DeepPartial<EntityRead>,
    findOptions?: AgGridFindManyOptions<EntityRead>,
    returnEntity?: true,
  ): Promise<EntityRead>;
  async updateEntity(
    conditions: FindConditions<EntityRead>,
    input: DeepPartial<EntityRead>,
    findOptions?: AgGridFindManyOptions<EntityRead>,
    returnEntity?: boolean,
  ): Promise<EntityRead | boolean>;
  async updateEntity(
    conditions: FindConditions<EntityRead>,
    input: DeepPartial<EntityRead>,
    findOptions?: AgGridFindManyOptions<EntityRead>,
    returnEntity = true,
  ): Promise<EntityRead | boolean> {
    const result = await this.validateConditions(conditions);

    /**
     * This is needed to keep the prototype of the
     * entity in order to allow the beforeUpdate to be executed
     */
    let entityHydrated = this.mapEntityR2W(input);
    const entity = this.entityWrite;
    if (isClass(entity)) {
      const _inputValues = entityHydrated;
      entityHydrated = new entity();
      Object.assign(entityHydrated, _inputValues);
    }

    const mappedConditions = this.mapEntityR2W(conditions);

    await this.repositoryWrite
      .update(mappedConditions, entityHydrated)
      .catch(validateSupportedError(UpdateEntityError));

    /**
     * Create where condition for the the identifiers
     */
    const ids = this.repository.getId(Object.assign(result, entityHydrated));
    const filters = this.repository.generateFilterOnPrimaryColumn(ids);

    return !returnEntity
      ? true
      : this.repository.getOneAgGrid(
          { ...findOptions, where: { filters } },
          true,
          ReplicationMode.MASTER,
        );
  }

  /**
   * Deletes an entity based in the provided conditions and returns wether or not the resource was deleted
   * @param conditions The conditions to delete
   * @throws DeleteEntityError
   * @throws NoResultsForConditions
   * @throws ConditionsTooBroadError
   */
  async deleteEntity(conditions: FindConditions<EntityRead>): Promise<boolean> {
    await this.validateConditions(conditions);

    const mappedConditions = this.mapEntityR2W(conditions);

    const result = await this.repositoryWrite
      .delete(mappedConditions)
      .catch(validateSupportedError(DeleteEntityError));

    return !!result.affected && result.affected > 0;
  }

  /**
   * Deletes all entities that match the provided conditions and returns how many entities where affected
   * @param conditions The conditions to delete
   * @throws DeleteEntityError
   */
  async deleteEntities(
    conditions: FindConditions<EntityRead>,
  ): Promise<number> {
    const mappedConditions = this.mapEntityR2W(conditions);

    const result = await this.repositoryWrite
      .delete(mappedConditions)
      .catch(validateSupportedError(DeleteEntityError));

    return result.affected || 0;
  }

  /**
   * Makes sure that the conditions will affect a single record
   * @param conditions
   * @throws NoResultsForConditions
   * @throws ConditionsTooBroadError
   */
  async validateConditions(
    conditions: FindConditions<EntityRead>,
  ): Promise<EntityRead> {
    const results = await this.repository.find({
      where: conditions,
      take: 2, // Prevent finding more records than we need for the validation
    });

    if (results.length === 0) {
      throw new NoResultsFoundError(conditions);
    }
    if (results.length > 1) {
      throw new ConditionsTooBroadError(conditions);
    }
    return results[0];
  }

  /**   * Returns a List of entities based in the provided options.
   * @param findOptions Filter options
   * @param withCount whether or not the number results should be returned
   * @param relations Related entities to load as part of the results
   * @param databaseName The database name, to open a new database connection
   */
  async getEntityListAgGrid(
    findOptions: AgGridFindManyOptions<EntityRead>,
    withCount?: false,
    relations?: string[],
    databaseName?: string,
  ): Promise<EntityRead[]>;
  async getEntityListAgGrid(
    findOptions: AgGridFindManyOptions<EntityRead>,
    withCount: true,
    relations?: string[],
    databaseName?: string,
  ): Promise<[EntityRead[], number]>;
  async getEntityListAgGrid(
    findOptions: AgGridFindManyOptions<EntityRead>,
    withCount = false,
    relations?: string[],
    databaseName?: string,
  ): Promise<[EntityRead[], number] | EntityRead[]> {
    // Allows to switch to a different database connection
    if (databaseName) this.switchDatabaseConnection(databaseName);
    if (relations) findOptions.relations = relations;

    return withCount
      ? this.repository.getManyAndCountAgGrid(findOptions)
      : this.repository.getManyAgGrid(findOptions);
  }

  protected mapEntityR2W(
    entityRead: FindConditions<EntityRead>,
  ): FindConditions<EntityWrite>;
  protected mapEntityR2W(
    entityRead: EntityRead | DeepPartial<EntityRead>,
  ): EntityWrite;
  protected mapEntityR2W(
    entityRead:
      | EntityRead
      | DeepPartial<EntityRead>
      | FindConditions<EntityRead>,
  ): EntityWrite | FindConditions<EntityWrite> {
    const entity = this.entityWrite;

    if (!isClass(entity) || !isClass(this.entityRead))
      return entityRead as EntityWrite;

    const newEntityWrite = new entity();

    const fieldMetadataList = getAgGridFieldMetadataList(this.entityRead);

    for (const propertyName of Object.keys(entityRead)) {
      const fieldMetadata = fieldMetadataList?.[propertyName];

      if (!fieldMetadata?.dst || !isDstExtended(fieldMetadata.dst)) {
        newEntityWrite[propertyName] =
          entityRead[propertyName as keyof EntityRead];
        continue;
      }

      const dst = fieldMetadata.dst;

      dst.transformer(
        newEntityWrite,
        entityRead[propertyName as keyof EntityRead],
      );
    }

    return newEntityWrite;
  }
}
