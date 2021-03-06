import { assoc, filter, includes, map, pipe } from 'ramda';
import {
  createEntity,
  deleteEntityById,
  executeWrite,
  find,
  loadEntityById,
  now,
  sinceNowInMinutes,
  updateAttribute,
} from '../database/grakn';
import { connectorConfig, registerConnectorQueues } from '../database/rabbitmq';
import { TYPE_OPENCTI_INTERNAL } from '../database/utils';

export const CONNECTOR_INTERNAL_IMPORT_FILE = 'INTERNAL_IMPORT_FILE'; // Files mime types to support (application/json, ...) -> import-
export const CONNECTOR_INTERNAL_EXPORT_FILE = 'INTERNAL_EXPORT_FILE'; // Files mime types to generate (application/pdf, ...) -> export-

// region utils
const completeConnector = (connector) => {
  return pipe(
    assoc('connector_scope', connector.connector_scope.split(',')),
    assoc('config', connectorConfig(connector.id)),
    assoc('active', sinceNowInMinutes(connector.updated_at) < 2)
  )(connector);
};
// endregion

// region grakn fetch
export const loadConnectorById = (id) => loadEntityById(id, 'Connector');
export const connectors = () => {
  const query = `match $c isa Connector; get;`;
  return find(query, ['c']).then((elements) => map((conn) => completeConnector(conn.c), elements));
};
export const connectorsFor = async (type, scope, onlyAlive = false) => {
  const connects = await connectors();
  return pipe(
    filter((c) => c.connector_type === type),
    filter((c) => (onlyAlive ? c.active === true : true)),
    // eslint-disable-next-line prettier/prettier
    filter((c) =>
      scope
        ? includes(
            scope.toLowerCase(),
            map((s) => s.toLowerCase(), c.connector_scope)
          )
        : true
    )
  )(connects);
};
export const connectorsForExport = async (scope, onlyAlive = false) =>
  connectorsFor(CONNECTOR_INTERNAL_EXPORT_FILE, scope, onlyAlive);
export const connectorsForImport = async (scope, onlyAlive = false) =>
  connectorsFor(CONNECTOR_INTERNAL_IMPORT_FILE, scope, onlyAlive);
// endregion

// region mutations
export const pingConnector = async (id, state) => {
  const creation = now();
  const connector = await loadEntityById(id, 'Connector');
  if (connector.connector_state_reset === true) {
    await executeWrite(async (wTx) => {
      const stateInput = { key: 'connector_state_reset', value: [false] };
      await updateAttribute(id, 'Connector', stateInput, wTx);
    });
  } else {
    await executeWrite(async (wTx) => {
      const updateInput = { key: 'updated_at', value: [creation] };
      await updateAttribute(id, 'Connector', updateInput, wTx);
      const stateInput = { key: 'connector_state', value: [state] };
      await updateAttribute(id, 'Connector', stateInput, wTx);
    });
  }
  return loadEntityById(id, 'Connector').then((data) => completeConnector(data));
};
export const resetStateConnector = async (id) => {
  await executeWrite(async (wTx) => {
    const stateInput = { key: 'connector_state', value: [''] };
    await updateAttribute(id, 'Connector', stateInput, wTx);
    const stateResetInput = { key: 'connector_state_reset', value: [true] };
    await updateAttribute(id, 'Connector', stateResetInput, wTx);
  });
  return loadEntityById(id, 'Connector').then((data) => completeConnector(data));
};
export const registerConnector = async ({ id, name, type, scope }) => {
  const connector = await loadEntityById(id, 'Connector');
  // Register queues
  await registerConnectorQueues(id, name, type, scope);
  if (connector) {
    // Simple connector update
    await executeWrite(async (wTx) => {
      const inputName = { key: 'name', value: [name] };
      await updateAttribute(id, 'Connector', inputName, wTx);
      const updatedInput = { key: 'updated_at', value: [now()] };
      await updateAttribute(id, 'Connector', updatedInput, wTx);
      const scopeInput = { key: 'connector_scope', value: [scope.join(',')] };
      await updateAttribute(id, 'Connector', scopeInput, wTx);
    });
    return loadEntityById(id, 'Connector').then((data) => completeConnector(data));
  }
  // Need to create the connector
  const connectorToCreate = { internal_id_key: id, name, connector_type: type, connector_scope: scope.join(',') };
  const createdConnector = await createEntity(null, connectorToCreate, 'Connector', {
    modelType: TYPE_OPENCTI_INTERNAL,
  });
  // Return the connector
  return completeConnector(createdConnector);
};
export const connectorDelete = async (connectorId) => deleteEntityById(connectorId, 'Connector');
// endregion
