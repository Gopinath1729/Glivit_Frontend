import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DeviceCreateForm } from '@/src/components/DeviceCreateForm';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Chip, EmptyLine, RowCard } from '@/src/components/ui/ModulePrimitives';
import { TextField } from '@/src/components/ui/TextField';
import { P } from '@/src/constants/permissions';
import { apiErrorMessage } from '@/src/services/apiError';
import {
  useDeleteDeviceMutation,
  useGetAllDevicesQuery,
  useUpdateDeviceMutation,
} from '@/src/services/devicesApi';
import {
  useCreateProjectMutation,
  useUpdateProjectMutation,
  useDeleteProjectMutation,
  useCreateUserMutation,
  useDeleteUserMutation,
  useGetAuditQuery,
  useGetProjectsQuery,
  useGetUsersQuery,
  useUpdateUserMutation,
} from '@/src/services/operationsApi';
import { useAppSelector, useHasPermission, useCanManageTenants } from '@/src/store/hooks';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';
import type { ManagedUserDto, ProjectDto } from '@/src/types/api';
import CommandsScreen from './commands';
import ManageTenantsScreen from './manage-tenants';

type PrimaryTab = 'management' | 'tenants' | 'commands';
type SubTab = 'devices' | 'users' | 'projects' | 'audit';
type Tab = PrimaryTab | SubTab;
type UserRole = 'ADMIN' | 'DRIVER';
type NewUserDraft = {
  name: string;
  username: string;
  mobile: string;
  password?: string;
  confirmPassword?: string;
  role: UserRole;
};

const EMPTY_USER: NewUserDraft = {
  name: '',
  username: '',
  mobile: '',
  password: '',
  confirmPassword: '',
  role: 'ADMIN',
};

export default function ManagementScreen() {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(c), [c]);
  const currentUser = useAppSelector((s) => s.auth.user);
  const canDevices = useHasPermission(P.CREATE_DEVICE);
  const canUsers = useHasPermission(P.MANAGE_USERS);
  const canProjects = useHasPermission(P.MANAGE_PROJECTS);
  const canAudit = useHasPermission(P.VIEW_AUDIT_LOGS);
  const canCommands = useHasPermission(P.SEND_COMMANDS);
  const canManageTenants = useCanManageTenants();
  const canManagement = canDevices || canUsers || canProjects || canAudit;
  const availablePrimaryTabs = useMemo(
    () =>
      [
        canManagement && 'management',
        canManageTenants && 'tenants',
        canCommands && 'commands',
      ].filter(Boolean) as PrimaryTab[],
    [canManagement, canManageTenants, canCommands]
  );
  const [primaryTab, setPrimaryTab] = useState<PrimaryTab>(availablePrimaryTabs[0] ?? 'management');

  const availableSubTabs = useMemo(
    () =>
      [
        canDevices && 'devices',
        canUsers && 'users',
        canProjects && 'projects',
        canAudit && 'audit',
      ].filter(Boolean) as SubTab[],
    [canDevices, canUsers, canProjects, canAudit]
  );
  const [subTab, setSubTab] = useState<SubTab>(availableSubTabs[0] ?? 'devices');

  // Device creation / edit modal state
  const [deviceModalVisible, setDeviceModalVisible] = useState(false);
  const [selectedDeviceForEdit, setSelectedDeviceForEdit] = useState<any | null>(null);

  // Users tab role filter & creation modal state
  const [userRoleTab, setUserRoleTab] = useState<UserRole>('ADMIN');
  const [userModalVisible, setUserModalVisible] = useState(false);

  // Users edit modal state
  const [selectedUserForEdit, setSelectedUserForEdit] = useState<ManagedUserDto | null>(null);
  const [editUserModalVisible, setEditUserModalVisible] = useState(false);
  const [editUserDraft, setEditUserDraft] = useState({
    name: '',
    username: '',
    mobile: '',
    password: '',
    confirmPassword: '',
    status: 'ACTIVE' as 'ACTIVE' | 'DISABLED',
  });

  // Project Modal state
  const [projectModalVisible, setProjectModalVisible] = useState(false);
  const [selectedProjectForEdit, setSelectedProjectForEdit] = useState<ProjectDto | null>(null);
  const [editProjectName, setEditProjectName] = useState('');
  const [editProjectStatus, setEditProjectStatus] = useState('ACTIVE');

  const allDevices = useGetAllDevicesQuery({ includeSuspended: true }, { skip: !canDevices });
  const [deleteDevice] = useDeleteDeviceMutation();
  const [updateDevice] = useUpdateDeviceMutation();

  const projects = useGetProjectsQuery(undefined, { skip: !canProjects });
  const users = useGetUsersQuery({ role: userRoleTab, size: 50 }, { skip: !canUsers });
  const audit = useGetAuditQuery({ size: 50 }, { skip: !canAudit });

  const [createProject, projectState] = useCreateProjectMutation();
  const [updateProject, updateProjectState] = useUpdateProjectMutation();
  const [deleteProject] = useDeleteProjectMutation();
  const [createUser, userState] = useCreateUserMutation();
  const [updateUser, updateUserState] = useUpdateUserMutation();
  const [deleteUser, deleteUserState] = useDeleteUserMutation();

  const [newUser, setNewUser] = useState<NewUserDraft>(EMPTY_USER);

  const filteredUsers = useMemo(() => {
    const content = users.data?.content ?? [];
    if (userRoleTab === 'DRIVER') {
      return content.filter((u) => u.role === 'DRIVER');
    }
    return content.filter((u) => u.role !== 'DRIVER');
  }, [users.data?.content, userRoleTab]);

  const openCreateUserModal = useCallback((role: UserRole) => {
    setNewUser({ name: '', username: '', mobile: '', password: '', confirmPassword: '', role });
    setUserModalVisible(true);
  }, []);

  const openEditUserModal = useCallback((user: ManagedUserDto) => {
    setSelectedUserForEdit(user);
    setEditUserDraft({
      name: user.name,
      username: user.username,
      mobile: user.mobile || '',
      password: '',
      confirmPassword: '',
      status: user.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
    });
    setEditUserModalVisible(true);
  }, []);

  const submitEditUser = async () => {
    if (!selectedUserForEdit) return;
    const isDriver = selectedUserForEdit.role === 'DRIVER';
    if (editUserDraft.password) {
      if (editUserDraft.password.length < 6) {
        Alert.alert('Validation Error', 'Password must be at least 6 characters.');
        return;
      }
      if (editUserDraft.password !== editUserDraft.confirmPassword) {
        Alert.alert('Validation Error', 'Password and confirm password do not match.');
        return;
      }
    }
    try {
      await updateUser({
        id: selectedUserForEdit.id,
        body: {
          username: editUserDraft.username.trim(),
          name: editUserDraft.name.trim(),
          mobile: editUserDraft.mobile.trim(),
          role: selectedUserForEdit.role,
          status: editUserDraft.status,
          ...(editUserDraft.password ? { password: editUserDraft.password } : {}),
        },
      }).unwrap();
      setEditUserModalVisible(false);
      setSelectedUserForEdit(null);
      void users.refetch();
      Alert.alert(
        isDriver ? 'Driver updated' : 'Admin updated',
        `${editUserDraft.name.trim()} has been updated successfully.`
      );
    } catch (err) {
      Alert.alert(isDriver ? 'Driver not updated' : 'Admin not updated', apiErrorMessage(err));
    }
  };

  const handleDeleteUser = (userToDelete: ManagedUserDto) => {
    if (
      currentUser?.id === userToDelete.id ||
      (currentUser?.username && currentUser.username.toLowerCase() === userToDelete.username.toLowerCase())
    ) {
      Alert.alert('Action Not Allowed', 'You cannot delete your own account.');
      return;
    }
    Alert.alert(
      userToDelete.role === 'DRIVER' ? 'Delete Driver' : 'Delete User',
      `Are you sure you want to delete/disable ${userToDelete.name}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteUser(userToDelete.id).unwrap();
              void users.refetch();
              Alert.alert('Success', `${userToDelete.name} has been deleted.`);
            } catch (err) {
              Alert.alert('Error', apiErrorMessage(err, 'Failed to delete user'));
            }
          },
        },
      ]
    );
  };

  const refreshing =
    (canDevices && allDevices.isFetching) ||
    (canProjects && projects.isFetching) ||
    (canUsers && users.isFetching) ||
    (canAudit && audit.isFetching);

  const refreshAll = useCallback(() => {
    if (canDevices) void allDevices.refetch();
    if (canProjects) void projects.refetch();
    if (canUsers) void users.refetch();
    if (canAudit) void audit.refetch();
  }, [canAudit, canDevices, canProjects, canUsers]);

  const submitProjectModal = async () => {
    if (!editProjectName.trim()) {
      Alert.alert('Validation Error', 'Project name cannot be empty.');
      return;
    }
    try {
      if (selectedProjectForEdit) {
        await updateProject({
          id: selectedProjectForEdit.id,
          body: { name: editProjectName.trim(), status: editProjectStatus },
        }).unwrap();
        Alert.alert('Success', 'Project updated successfully.');
      } else {
        await createProject({ name: editProjectName.trim(), status: 'ACTIVE' }).unwrap();
        Alert.alert('Success', 'Project created successfully.');
      }
      setProjectModalVisible(false);
      setSelectedProjectForEdit(null);
      void projects.refetch();
    } catch (err) {
      Alert.alert('Error', apiErrorMessage(err));
    }
  };


  const submitUser = async () => {
    const isDriver = newUser.role === 'DRIVER';
    if (!newUser.password || newUser.password.length < 6) {
      Alert.alert('Validation Error', 'Password must be at least 6 characters.');
      return;
    }
    if (newUser.password !== newUser.confirmPassword) {
      Alert.alert('Validation Error', 'Password and confirm password do not match.');
      return;
    }
    try {
      await createUser({
        username: newUser.username.trim(),
        name: newUser.name.trim(),
        mobile: newUser.mobile.trim(),
        password: newUser.password,
        role: newUser.role,
        status: 'ACTIVE',
        permissions: {},
      }).unwrap();
      setUserModalVisible(false);
      setNewUser(EMPTY_USER);
      void users.refetch();
      Alert.alert(
        isDriver ? 'Driver created' : 'Admin created',
        isDriver
          ? `${newUser.name.trim()} can sign in using their registered email and password.`
          : `${newUser.name.trim()} can sign in using their registered email and password.`
      );
    } catch (err) {
      Alert.alert(isDriver ? 'Driver not saved' : 'Admin not saved', apiErrorMessage(err));
    }
  };

  if (availablePrimaryTabs.length === 0) {
    return <EmptyLine text="No management modules are available for this account." />;
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.tabRow, { paddingHorizontal: spacing.md, paddingVertical: spacing.sm }]}
        style={styles.tabRowScrollView}>
        {availablePrimaryTabs.map((value) => (
          <Chip
            key={value}
            active={primaryTab === value}
            label={value === 'management' ? 'Management' : value === 'tenants' ? 'Manage Tenants' : 'Device Commands'}
            onPress={() => setPrimaryTab(value)}
          />
        ))}
      </ScrollView>

      {primaryTab === 'management' && availableSubTabs.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={[styles.subTabRow, { paddingHorizontal: spacing.md }]}
          style={styles.subTabRowScrollView}>
          {availableSubTabs.map((value) => {
            const isActive = subTab === value;
            return (
              <Pressable
                key={value}
                onPress={() => setSubTab(value)}
                style={[styles.subTabItem, isActive && styles.subTabItemActive]}>
                <Text style={[styles.subTabItemText, isActive && styles.subTabItemTextActive]}>
                  {value === 'devices' ? 'Devices' : value === 'users' ? 'Users' : value === 'projects' ? 'Projects' : 'Audit'}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {primaryTab === 'management' && ['devices', 'users', 'projects', 'audit'].includes(subTab) ? (
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
          refreshControl={
            <RefreshControl onRefresh={refreshAll} refreshing={Boolean(refreshing)} tintColor={c.primary} />
          }
          style={styles.screen}>

        {/* Devices Tab */}
        {subTab === 'devices' && canDevices ? (
          <Card style={[styles.form, { flex: 1 }]}>
            <View style={styles.titleRow}>
              <Text style={styles.title}>Devices</Text>
              <TouchableOpacity
                accessibilityLabel="Create Device"
                accessibilityRole="button"
                activeOpacity={0.75}
                onPress={() => {
                  setSelectedDeviceForEdit(null);
                  setDeviceModalVisible(true);
                }}
                style={styles.headerPlusButton}>
                <MaterialCommunityIcons color={c.primary} name="plus" size={24} />
              </TouchableOpacity>
            </View>
            <Text style={styles.sectionHint}>
              Manage registered GPS devices. Active devices must be deactivated before deletion.
            </Text>

            <ListState
              emptyText="No devices created yet. Tap + to register a device."
              error={allDevices.error}
              isError={allDevices.isError}
              isLoading={allDevices.isLoading}
              isEmpty={(allDevices.data?.length ?? 0) === 0}
              onRetry={allDevices.refetch}
              styles={styles}
              tint={c.primary}
            />

            {(allDevices.data ?? []).map((device) => {
              const isActive = device.status === 'ACTIVE' || (!device.status && !(device as any).suspended);
              return (
                <View key={device.id} style={styles.deviceCard}>
                  <View style={styles.deviceHeader}>
                    <View style={styles.deviceTitleGroup}>
                      <MaterialCommunityIcons color={c.primary} name="cellphone-link" size={20} />
                      <Text style={styles.deviceName}>{device.name}</Text>
                    </View>
                    <View style={[styles.statusBadge, isActive ? styles.statusBadgeActive : styles.statusBadgeInactive]}>
                      <Text style={[styles.statusText, isActive ? styles.statusTextActive : styles.statusTextInactive]}>
                        {isActive ? 'ACTIVE' : 'INACTIVE'}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.deviceDetailsGrid}>
                    <View style={styles.deviceDetailItem}>
                      <Text style={styles.detailLabel}>IMEI</Text>
                      <Text style={styles.detailValue}>{device.imei}</Text>
                    </View>
                    <View style={styles.deviceDetailItem}>
                      <Text style={styles.detailLabel}>Type</Text>
                      <Text style={styles.detailValue}>{device.category || 'GPS'}</Text>
                    </View>
                    <View style={styles.deviceDetailItem}>
                      <Text style={styles.detailLabel}>SIM</Text>
                      <Text style={styles.detailValue}>{device.simNumber || device.simProvider || 'No SIM'}</Text>
                    </View>
                    <View style={styles.deviceDetailItem}>
                      <Text style={styles.detailLabel}>Driver</Text>
                      <Text style={styles.detailValue}>{device.driverName || 'Unassigned'}</Text>
                    </View>
                  </View>

                  <View style={styles.deviceActionsRow}>
                    <TouchableOpacity
                      onPress={() => {
                        setSelectedDeviceForEdit(device);
                        setDeviceModalVisible(true);
                      }}
                      style={styles.actionBtnSecondary}>
                      <MaterialCommunityIcons color={c.primary} name="pencil-outline" size={16} />
                      <Text style={styles.actionBtnTextSecondary}>Edit</Text>
                    </TouchableOpacity>

                    {isActive ? (
                      <TouchableOpacity
                        onPress={() => {
                          Alert.alert(
                            'Deactivate Device',
                            `Are you sure you want to deactivate "${device.name}"? It will be marked inactive.`,
                            [
                              { text: 'Cancel', style: 'cancel' },
                              {
                                text: 'Deactivate',
                                style: 'destructive',
                                onPress: async () => {
                                  try {
                                    await deleteDevice(device.id).unwrap();
                                    void allDevices.refetch();
                                  } catch (err) {
                                    Alert.alert('Action failed', apiErrorMessage(err));
                                  }
                                },
                              },
                            ]
                          );
                        }}
                        style={styles.actionBtnWarning}>
                        <MaterialCommunityIcons color="#F59E0B" name="pause-circle-outline" size={16} />
                        <Text style={styles.actionBtnTextWarning}>Deactivate</Text>
                      </TouchableOpacity>
                    ) : (
                      <>
                        <TouchableOpacity
                          onPress={() => {
                            Alert.alert(
                              'Activate Device',
                              `Are you sure you want to activate "${device.name}"?`,
                              [
                                { text: 'Cancel', style: 'cancel' },
                                {
                                  text: 'Activate',
                                  onPress: async () => {
                                    try {
                                      await updateDevice({
                                        id: device.id,
                                        body: {
                                          category: device.category || 'CAR',
                                          imei: device.imei,
                                          name: device.name,
                                          status: 'ACTIVE',
                                        },
                                      }).unwrap();
                                      void allDevices.refetch();
                                    } catch (err) {
                                      Alert.alert('Action failed', apiErrorMessage(err));
                                    }
                                  },
                                },
                              ]
                            );
                          }}
                          style={styles.actionBtnSuccess}>
                          <MaterialCommunityIcons color="#22C55E" name="play-circle-outline" size={16} />
                          <Text style={styles.actionBtnTextSuccess}>Activate</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          onPress={() => {
                            Alert.alert(
                              'Delete Device',
                              `Are you sure you want to permanently delete "${device.name}"? This action cannot be undone.`,
                              [
                                { text: 'Cancel', style: 'cancel' },
                                {
                                  text: 'Delete',
                                  style: 'destructive',
                                  onPress: async () => {
                                    try {
                                      await deleteDevice(device.id).unwrap();
                                      void allDevices.refetch();
                                    } catch (err) {
                                      Alert.alert('Action failed', apiErrorMessage(err));
                                    }
                                  },
                                },
                              ]
                            );
                          }}
                          style={styles.actionBtnDanger}>
                          <MaterialCommunityIcons color="#EF4444" name="trash-can-outline" size={16} />
                          <Text style={styles.actionBtnTextDanger}>Delete</Text>
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                </View>
              );
            })}
          </Card>
        ) : null}

        {/* Users Tab */}
        {subTab === 'users' && canUsers ? (
          <Card style={[styles.form, { flex: 1 }]}>
            <View style={styles.titleRow}>
              <Text style={styles.title}>Users & Drivers</Text>
              <TouchableOpacity
                accessibilityLabel={`Create ${userRoleTab === 'DRIVER' ? 'Driver' : 'Admin'}`}
                accessibilityRole="button"
                activeOpacity={0.75}
                onPress={() => openCreateUserModal(userRoleTab)}
                style={styles.headerPlusButton}>
                <MaterialCommunityIcons color={c.primary} name="plus" size={24} />
              </TouchableOpacity>
            </View>
            <Text style={styles.sectionHint}>
              Select Admin or Driver to view matching users. Tap the + icon on the right to create a new user with the selected role.
            </Text>

            <View style={styles.roleFilterRow}>
              {(['ADMIN', 'DRIVER'] as const).map((role) => (
                <Chip
                  key={role}
                  active={userRoleTab === role}
                  label={role === 'DRIVER' ? 'Driver' : 'Admin'}
                  onPress={() => setUserRoleTab(role)}
                />
              ))}
            </View>

            <ListState
              emptyText={userRoleTab === 'DRIVER' ? 'No drivers found.' : 'No admin users found.'}
              error={users.error}
              isError={users.isError}
              isLoading={users.isLoading}
              isEmpty={filteredUsers.length === 0}
              onRetry={users.refetch}
              styles={styles}
              tint={c.primary}
            />

            {filteredUsers.map((user) => {
              const isSelf =
                currentUser?.id === user.id ||
                (currentUser?.username &&
                  currentUser.username.toLowerCase() === user.username.toLowerCase());
              return (
                <View key={user.id} style={styles.deviceCard}>
                  <View style={styles.deviceHeader}>
                    <View style={styles.deviceTitleGroup}>
                      <MaterialCommunityIcons
                        color={c.primary}
                        name={user.role === 'DRIVER' ? 'card-account-details-outline' : 'account-outline'}
                        size={22}
                      />
                      <View>
                        <Text style={styles.deviceName}>{user.name}</Text>
                        <Text style={styles.detailLabel}>{user.username}</Text>
                      </View>
                    </View>
                    <View
                      style={[
                        styles.statusBadge,
                        user.status === 'ACTIVE' ? styles.statusBadgeActive : styles.statusBadgeInactive,
                      ]}>
                      <Text
                        style={[
                          styles.statusText,
                          user.status === 'ACTIVE' ? styles.statusTextActive : styles.statusTextInactive,
                        ]}>
                        {user.status === 'ACTIVE' ? 'Active' : 'Disabled'}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.deviceDetailsGrid}>
                    <View style={styles.deviceDetailItem}>
                      <Text style={styles.detailLabel}>Role</Text>
                      <Text style={styles.detailValue}>
                        {user.role === 'DRIVER' ? 'Driver' : 'Admin'}
                      </Text>
                    </View>
                    {user.mobile ? (
                      <View style={styles.deviceDetailItem}>
                        <Text style={styles.detailLabel}>Mobile</Text>
                        <Text style={styles.detailValue}>{user.mobile}</Text>
                      </View>
                    ) : null}
                  </View>

                  <View style={styles.deviceActionsRow}>
                    <TouchableOpacity
                      accessibilityLabel={`Edit ${user.name}`}
                      accessibilityRole="button"
                      activeOpacity={0.7}
                      onPress={() => openEditUserModal(user)}
                      style={styles.actionBtnSecondary}>
                      <MaterialCommunityIcons color={c.textPrimary} name="pencil-outline" size={14} />
                      <Text style={styles.actionBtnTextSecondary}>Edit</Text>
                    </TouchableOpacity>

                    {!isSelf ? (
                      <TouchableOpacity
                        accessibilityLabel={`Delete ${user.name}`}
                        accessibilityRole="button"
                        activeOpacity={0.7}
                        onPress={() => handleDeleteUser(user)}
                        style={styles.actionBtnDanger}>
                        <MaterialCommunityIcons color="#EF4444" name="trash-can-outline" size={14} />
                        <Text style={styles.actionBtnTextDanger}>Delete</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </Card>
        ) : null}

        {subTab === 'projects' && canProjects ? (
          <Card style={[styles.form, { flex: 1 }]}>
            <View style={styles.titleRow}>
              <Text style={styles.title}>Projects</Text>
              <TouchableOpacity
                accessibilityLabel="Create Project"
                accessibilityRole="button"
                activeOpacity={0.75}
                onPress={() => {
                  setSelectedProjectForEdit(null);
                  setEditProjectName('');
                  setEditProjectStatus('ACTIVE');
                  setProjectModalVisible(true);
                }}
                style={styles.headerPlusButton}>
                <MaterialCommunityIcons color={c.primary} name="plus" size={24} />
              </TouchableOpacity>
            </View>
            <Text style={styles.sectionHint}>
              Manage tenant projects. Edit name or status. Delete inactive projects.
            </Text>

            <ListState
              emptyText="No projects yet. Tap + to create a project."
              error={projects.error}
              isError={projects.isError}
              isLoading={projects.isLoading}
              isEmpty={(projects.data?.length ?? 0) === 0}
              onRetry={projects.refetch}
              styles={styles}
              tint={c.primary}
            />

            {(projects.data ?? []).map((project) => {
              const isActive = project.status === 'ACTIVE';
              return (
                <View key={project.id} style={styles.deviceCard}>
                  <View style={styles.deviceHeader}>
                    <View style={styles.deviceTitleGroup}>
                      <MaterialCommunityIcons color={c.primary} name="folder-outline" size={22} />
                      <Text style={styles.deviceName}>{project.name}</Text>
                    </View>
                    <View style={[styles.statusBadge, isActive ? styles.statusBadgeActive : styles.statusBadgeInactive]}>
                      <Text style={[styles.statusText, isActive ? styles.statusTextActive : styles.statusTextInactive]}>
                        {isActive ? 'ACTIVE' : 'INACTIVE'}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.deviceActionsRow}>
                    <TouchableOpacity
                      onPress={() => {
                        setSelectedProjectForEdit(project);
                        setEditProjectName(project.name);
                        setEditProjectStatus(project.status);
                        setProjectModalVisible(true);
                      }}
                      style={styles.actionBtnSecondary}>
                      <MaterialCommunityIcons color={c.textPrimary} name="pencil-outline" size={14} />
                      <Text style={styles.actionBtnTextSecondary}>Edit</Text>
                    </TouchableOpacity>

                    {!isActive ? (
                      <TouchableOpacity
                        onPress={() => {
                          Alert.alert(
                            'Delete Project',
                            `Are you sure you want to permanently delete "${project.name}"? This action cannot be undone.`,
                            [
                              { text: 'Cancel', style: 'cancel' },
                              {
                                text: 'Delete',
                                style: 'destructive',
                                onPress: async () => {
                                  try {
                                    await deleteProject(project.id).unwrap();
                                    void projects.refetch();
                                    Alert.alert('Success', 'Project deleted successfully.');
                                  } catch (err) {
                                    Alert.alert('Action failed', apiErrorMessage(err));
                                  }
                                },
                              },
                            ]
                          );
                        }}
                        style={styles.actionBtnDanger}>
                        <MaterialCommunityIcons color="#EF4444" name="trash-can-outline" size={14} />
                        <Text style={styles.actionBtnTextDanger}>Delete</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </Card>
        ) : null}

        {subTab === 'audit' && canAudit ? (
          <Card style={[styles.form, { flex: 1 }]}>
            <Text style={styles.title}>Audit Logs</Text>
            <ListState
              emptyText="No audit entries yet."
              error={audit.error}
              isError={audit.isError}
              isLoading={audit.isLoading}
              isEmpty={(audit.data?.content.length ?? 0) === 0}
              onRetry={audit.refetch}
              styles={styles}
              tint={c.primary}
            />
            {audit.data?.content.map((entry) => (
              <RowCard
                key={entry.id}
                icon="shield-search"
                title={entry.action}
                meta={`${entry.username ?? 'system'} | ${entry.entityType ?? ''} ${entry.entityId ?? ''}`}
              />
            )) ?? null}
          </Card>
        ) : null}
      </ScrollView>
      ) : null}

      {/* Device Commands Tab */}
      {primaryTab === 'commands' && canCommands ? (
        <CommandsScreen />
      ) : null}

      {/* Manage Tenants Tab */}
      {primaryTab === 'tenants' && canManageTenants ? (
        <ManageTenantsScreen />
      ) : null}

      {/* Device Modal for Create & Edit */}
      {primaryTab === 'management' && subTab === 'devices' && canDevices ? (
        <Modal
          animationType="slide"
          hardwareAccelerated
          onRequestClose={() => {
            setDeviceModalVisible(false);
            setSelectedDeviceForEdit(null);
          }}
          transparent
          visible={deviceModalVisible}>
          <View style={styles.modalOverlay}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => {
                setDeviceModalVisible(false);
                setSelectedDeviceForEdit(null);
              }}
            />
            <View
              style={[
                styles.modalSheetContainer,
                { paddingBottom: Math.max(insets.bottom + spacing.md, spacing.lg) },
              ]}>
              <View style={styles.modalHandle} />
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>
                  {selectedDeviceForEdit ? 'Edit Device' : 'Create Device'}
                </Text>
                <Pressable
                  onPress={() => {
                    setDeviceModalVisible(false);
                    setSelectedDeviceForEdit(null);
                  }}
                  style={styles.closeButton}>
                  <MaterialCommunityIcons color={c.textSecondary} name="close" size={20} />
                </Pressable>
              </View>

              <ScrollView
                contentContainerStyle={styles.modalScrollBody}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
                showsVerticalScrollIndicator={true}
                style={styles.modalScrollView}>
                <DeviceCreateForm
                  initialDevice={selectedDeviceForEdit}
                  onCancel={() => {
                    setDeviceModalVisible(false);
                    setSelectedDeviceForEdit(null);
                  }}
                  onSuccess={() => {
                    setDeviceModalVisible(false);
                    setSelectedDeviceForEdit(null);
                    void allDevices.refetch();
                  }}
                />
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}

      {/* User Creation Modal */}
      {primaryTab === 'management' && subTab === 'users' && canUsers ? (
        <Modal
          animationType="slide"
          hardwareAccelerated
          onRequestClose={() => setUserModalVisible(false)}
          transparent
          visible={userModalVisible}>
          <View style={styles.modalOverlay}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setUserModalVisible(false)} />
            <View
              style={[
                styles.modalSheetContainer,
                { paddingBottom: Math.max(insets.bottom + spacing.md, spacing.lg) },
              ]}>
              <View style={styles.modalHandle} />
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>
                  {newUser.role === 'DRIVER' ? 'Create Driver' : 'Create Admin'}
                </Text>
                <Pressable onPress={() => setUserModalVisible(false)} style={styles.closeButton}>
                  <MaterialCommunityIcons color={c.textSecondary} name="close" size={20} />
                </Pressable>
              </View>

              <ScrollView
                contentContainerStyle={styles.modalScrollBody}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
                showsVerticalScrollIndicator={true}
                style={styles.modalScrollView}>
                <Text style={styles.sectionHint}>
                  Users authenticate using their Microsoft account ID/email. Drivers get a login and driver record for vehicle assignment.
                </Text>

                <TextField
                  label="Full name"
                  onChangeText={(name) => setNewUser((v) => ({ ...v, name }))}
                  value={newUser.name}
                />
                <TextField
                  autoCapitalize="none"
                  keyboardType="email-address"
                  label="Username (Microsoft account ID/email)"
                  onChangeText={(username) => setNewUser((v) => ({ ...v, username }))}
                  placeholder="user@company.com"
                  value={newUser.username}
                />
                <TextField
                  keyboardType="phone-pad"
                  label="Mobile number"
                  onChangeText={(mobile) => setNewUser((v) => ({ ...v, mobile }))}
                  placeholder="+91 98765 43210"
                  value={newUser.mobile}
                />
                <TextField
                  label="Password"
                  onChangeText={(password) => setNewUser((v) => ({ ...v, password }))}
                  placeholder="Enter password (min 6 characters)"
                  secure
                  value={newUser.password ?? ''}
                />
                <TextField
                  error={
                    newUser.confirmPassword && newUser.confirmPassword !== newUser.password
                      ? 'Passwords do not match'
                      : undefined
                  }
                  label="Confirm password"
                  onChangeText={(confirmPassword) => setNewUser((v) => ({ ...v, confirmPassword }))}
                  placeholder="Re-enter password"
                  secure
                  value={newUser.confirmPassword ?? ''}
                />

                <Button
                  disabled={
                    !newUser.name.trim() ||
                    !newUser.username.trim() ||
                    !newUser.mobile.trim() ||
                    !newUser.password ||
                    newUser.password.length < 6 ||
                    newUser.password !== newUser.confirmPassword
                  }
                  label={newUser.role === 'DRIVER' ? 'Create driver' : 'Create admin'}
                  loading={userState.isLoading}
                  onPress={submitUser}
                />
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}

      {/* Edit User Modal */}
      {selectedUserForEdit && canUsers ? (
        <Modal
          animationType="slide"
          hardwareAccelerated
          onRequestClose={() => setEditUserModalVisible(false)}
          transparent
          visible={editUserModalVisible}>
          <View style={styles.modalOverlay}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setEditUserModalVisible(false)} />
            <View
              style={[
                styles.modalSheetContainer,
                { paddingBottom: Math.max(insets.bottom + spacing.md, spacing.lg) },
              ]}>
              <View style={styles.modalHandle} />
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>
                  {selectedUserForEdit.role === 'DRIVER' ? 'Edit Driver' : 'Edit Admin'}
                </Text>
                <Pressable onPress={() => setEditUserModalVisible(false)} style={styles.closeButton}>
                  <MaterialCommunityIcons color={c.textSecondary} name="close" size={20} />
                </Pressable>
              </View>

              <ScrollView
                contentContainerStyle={styles.modalScrollBody}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
                showsVerticalScrollIndicator={true}
                style={styles.modalScrollView}>
                <TextField
                  label="Full name"
                  onChangeText={(name) => setEditUserDraft((v) => ({ ...v, name }))}
                  value={editUserDraft.name}
                />
                <TextField
                  autoCapitalize="none"
                  keyboardType="email-address"
                  label="Username (Microsoft account ID/email)"
                  onChangeText={(username) => setEditUserDraft((v) => ({ ...v, username }))}
                  value={editUserDraft.username}
                />
                <TextField
                  keyboardType="phone-pad"
                  label="Mobile number"
                  onChangeText={(mobile) => setEditUserDraft((v) => ({ ...v, mobile }))}
                  placeholder="+91 98765 43210"
                  value={editUserDraft.mobile}
                />
                <TextField
                  label="New password (optional)"
                  onChangeText={(password) => setEditUserDraft((v) => ({ ...v, password }))}
                  placeholder="Leave blank to keep current password"
                  secure
                  value={editUserDraft.password ?? ''}
                />
                {editUserDraft.password ? (
                  <TextField
                    error={
                      editUserDraft.confirmPassword &&
                      editUserDraft.confirmPassword !== editUserDraft.password
                        ? 'Passwords do not match'
                        : undefined
                    }
                    label="Confirm new password"
                    onChangeText={(confirmPassword) => setEditUserDraft((v) => ({ ...v, confirmPassword }))}
                    placeholder="Re-enter new password"
                    secure
                    value={editUserDraft.confirmPassword ?? ''}
                  />
                ) : null}

                <View style={{ gap: spacing.xs }}>
                  <Text style={styles.detailLabel}>Account Status</Text>
                  <View style={styles.roleFilterRow}>
                    <Chip
                      active={editUserDraft.status === 'ACTIVE'}
                      label="Active"
                      onPress={() => setEditUserDraft((v) => ({ ...v, status: 'ACTIVE' }))}
                    />
                    <Chip
                      active={editUserDraft.status === 'DISABLED'}
                      label="Disabled"
                      onPress={() => setEditUserDraft((v) => ({ ...v, status: 'DISABLED' }))}
                    />
                  </View>
                </View>

                <Button
                  disabled={
                    !editUserDraft.name.trim() ||
                    !editUserDraft.username.trim() ||
                    !editUserDraft.mobile.trim() ||
                    (Boolean(editUserDraft.password) &&
                      (editUserDraft.password!.length < 6 ||
                        editUserDraft.password !== editUserDraft.confirmPassword))
                  }
                  label="Save changes"
                  loading={updateUserState.isLoading}
                  onPress={submitEditUser}
                />
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}

      {/* Project Creation & Edit Modal */}
      {primaryTab === 'management' && subTab === 'projects' && canProjects ? (
        <Modal
          animationType="slide"
          hardwareAccelerated
          onRequestClose={() => {
            setProjectModalVisible(false);
            setSelectedProjectForEdit(null);
          }}
          transparent
          visible={projectModalVisible}>
          <View style={styles.modalOverlay}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => {
                setProjectModalVisible(false);
                setSelectedProjectForEdit(null);
              }}
            />
            <View
              style={[
                styles.modalSheetContainer,
                { paddingBottom: Math.max(insets.bottom + spacing.md, spacing.lg) },
              ]}>
              <View style={styles.modalHandle} />
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>
                  {selectedProjectForEdit ? 'Edit Project' : 'Create Project'}
                </Text>
                <Pressable
                  onPress={() => {
                    setProjectModalVisible(false);
                    setSelectedProjectForEdit(null);
                  }}
                  style={styles.closeButton}>
                  <MaterialCommunityIcons color={c.textSecondary} name="close" size={20} />
                </Pressable>
              </View>

              <ScrollView
                contentContainerStyle={styles.modalScrollBody}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
                showsVerticalScrollIndicator={true}
                style={styles.modalScrollView}>
                <TextField
                  label="Project name"
                  onChangeText={setEditProjectName}
                  value={editProjectName}
                />

                {selectedProjectForEdit ? (
                  <View style={{ gap: spacing.xs, marginBottom: spacing.md }}>
                    <Text style={styles.detailLabel}>Project Status</Text>
                    <View style={styles.roleFilterRow}>
                      <Chip
                        active={editProjectStatus === 'ACTIVE'}
                        label="Active"
                        onPress={() => setEditProjectStatus('ACTIVE')}
                      />
                      <Chip
                        active={editProjectStatus === 'INACTIVE'}
                        label="Inactive"
                        onPress={() => setEditProjectStatus('INACTIVE')}
                      />
                    </View>
                  </View>
                ) : null}

                <Button
                  disabled={!editProjectName.trim()}
                  label={selectedProjectForEdit ? 'Save changes' : 'Create project'}
                  loading={selectedProjectForEdit ? updateProjectState.isLoading : projectState.isLoading}
                  onPress={submitProjectModal}
                />
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

function ListState({
  emptyText,
  error,
  isEmpty,
  isError,
  isLoading,
  onRetry,
  styles,
  tint,
}: {
  emptyText: string;
  error: unknown;
  isEmpty: boolean;
  isError: boolean;
  isLoading: boolean;
  onRetry: () => void;
  styles: ReturnType<typeof makeStyles>;
  tint: string;
}) {
  if (isLoading) {
    return (
      <View style={styles.listState}>
        <ActivityIndicator color={tint} size="small" />
        <Text style={styles.listStateText}>Loading…</Text>
      </View>
    );
  }
  if (isError) {
    return (
      <View style={styles.listState}>
        <MaterialCommunityIcons color={tint} name="alert-circle-outline" size={20} />
        <Text style={styles.listStateText}>{apiErrorMessage(error)}</Text>
        <Button label="Retry" icon="refresh" onPress={onRetry} variant="secondary" />
      </View>
    );
  }
  if (isEmpty) {
    return (
      <View style={styles.listState}>
        <Text style={styles.listStateText}>{emptyText}</Text>
      </View>
    );
  }
  return null;
}

function Section({
  title,
  children,
  buttonLabel,
  loading,
  submitDisabled,
  onSubmit,
}: {
  title: string;
  children: React.ReactNode;
  buttonLabel: string;
  loading: boolean;
  submitDisabled?: boolean;
  onSubmit: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <Card style={[styles.form, { flex: 1 }]}>
      <Text style={styles.title}>{title}</Text>
      {children}
      <Button disabled={submitDisabled} label={buttonLabel} loading={loading} onPress={onSubmit} />
    </Card>
  );
}

function label(tab: Tab) {
  if (tab === 'commands') return 'Device Commands';
  if (tab === 'tenants') return 'Manage Tenants';
  return tab.charAt(0).toUpperCase() + tab.slice(1);
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    content: {
      backgroundColor: c.pageBackground,
      flexGrow: 1,
      gap: spacing.md,
      padding: spacing.md,
    },
    tabRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
    tabRowScrollView: {
      flexGrow: 0,
      maxHeight: 64,
    },
    subTabRow: {
      flexDirection: 'row',
      gap: spacing.lg,
    },
    subTabRowScrollView: {
      flexGrow: 0,
      borderBottomWidth: 1,
      borderBottomColor: c.divider,
    },
    subTabItem: {
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.xs,
      borderBottomWidth: 2,
      borderBottomColor: 'transparent',
    },
    subTabItemActive: {
      borderBottomColor: c.primaryGreen,
    },
    subTabItemText: {
      color: c.textMuted,
      fontSize: 14,
      fontWeight: '600',
    },
    subTabItemTextActive: {
      color: c.primaryGreen,
      fontWeight: '700',
    },
    roleFilterRow: { flexDirection: 'row', gap: spacing.sm, marginVertical: spacing.xs },
    form: { gap: spacing.md },
    titleRow: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    title: { color: c.textPrimary, fontSize: typography.title, fontWeight: '900' },
    headerPlusButton: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt || 'rgba(255, 255, 255, 0.05)',
      borderRadius: 18,
      height: 36,
      justifyContent: 'center',
      width: 36,
    },
    sectionHint: { color: c.textSecondary, fontSize: typography.caption, lineHeight: 17 },
    listState: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      gap: spacing.sm,
      justifyContent: 'center',
      minHeight: 72,
      padding: spacing.md,
    },
    listStateText: {
      color: c.textSecondary,
      fontSize: typography.caption,
      textAlign: 'center',
    },
    deviceCard: {
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: 1,
      gap: spacing.sm,
      padding: spacing.md,
    },
    deviceHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    deviceTitleGroup: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.xs,
    },
    deviceName: {
      color: c.textPrimary,
      fontSize: typography.label,
      fontWeight: '800',
    },
    statusBadge: {
      borderRadius: radius.pill,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    statusBadgeActive: {
      backgroundColor: 'rgba(34, 197, 94, 0.15)',
    },
    statusBadgeInactive: {
      backgroundColor: 'rgba(148, 163, 184, 0.15)',
    },
    statusText: {
      fontSize: 10,
      fontWeight: '800',
    },
    statusTextActive: {
      color: '#22C55E',
    },
    statusTextInactive: {
      color: c.textSecondary,
    },
    deviceDetailsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    deviceDetailItem: {
      width: '48%',
    },
    detailLabel: {
      color: c.textMuted,
      fontSize: 11,
    },
    detailValue: {
      color: c.textPrimary,
      fontSize: 12,
      fontWeight: '600',
    },
    deviceActionsRow: {
      borderTopColor: c.divider,
      borderTopWidth: 1,
      flexDirection: 'row',
      gap: spacing.xs,
      justifyContent: 'flex-end',
      paddingTop: spacing.xs,
    },
    actionBtnSecondary: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderRadius: radius.sm,
      flexDirection: 'row',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
    },
    actionBtnTextSecondary: {
      color: c.primary,
      fontSize: 12,
      fontWeight: '700',
    },
    actionBtnWarning: {
      alignItems: 'center',
      backgroundColor: 'rgba(245, 158, 11, 0.12)',
      borderRadius: radius.sm,
      flexDirection: 'row',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
    },
    actionBtnTextWarning: {
      color: '#F59E0B',
      fontSize: 12,
      fontWeight: '700',
    },
    actionBtnSuccess: {
      alignItems: 'center',
      backgroundColor: 'rgba(34, 197, 94, 0.12)',
      borderRadius: radius.sm,
      flexDirection: 'row',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
    },
    actionBtnTextSuccess: {
      color: '#22C55E',
      fontSize: 12,
      fontWeight: '700',
    },
    actionBtnDanger: {
      alignItems: 'center',
      backgroundColor: 'rgba(239, 68, 68, 0.12)',
      borderRadius: radius.sm,
      flexDirection: 'row',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
    },
    actionBtnTextDanger: {
      color: '#EF4444',
      fontSize: 12,
      fontWeight: '700',
    },
    modalOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0, 0, 0, 0.55)',
      justifyContent: 'flex-end',
    },
    modalSheetContainer: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      maxHeight: '85%',
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.xs,
      width: '100%',
    },
    modalScrollView: {
      flexGrow: 1,
    },
    modalScrollBody: {
      gap: spacing.md,
      paddingBottom: spacing.xl,
      paddingTop: spacing.xs,
    },
    modalContent: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.xs,
    },
    modalHandle: {
      alignSelf: 'center',
      backgroundColor: c.borderStrong || '#334155',
      borderRadius: 3,
      height: 4,
      marginBottom: spacing.xs,
      marginTop: spacing.xs,
      width: 36,
    },
    modalHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: spacing.xs,
    },
    modalTitle: {
      color: c.textPrimary,
      fontSize: 18,
      fontWeight: '800',
    },
    closeButton: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt || 'rgba(255, 255, 255, 0.05)',
      borderRadius: radius.pill,
      height: 32,
      justifyContent: 'center',
      width: 32,
    },
  });
