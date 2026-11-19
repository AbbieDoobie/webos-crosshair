#Native crosshair service. Built with the buildroot-nc4 webOS toolchain:
#  cmake -S crosshair/native -B build/native/cmake \
#        -DCMAKE_TOOLCHAIN_FILE=<sdk>/share/buildroot/toolchainfile.cmake \
#        -DSCHEMA_DIR=build/native/gen
#scripts/build-native.sh does this (scripts/build.py calls it).
cmake_minimum_required(VERSION 3.10)
project(crosshair_service C)

set(SCHEMA_DIR "" CACHE PATH "Folder holding config_schema.h (scripts/gen_schema.py)")
if(NOT EXISTS "${SCHEMA_DIR}/config_schema.h")
    message(FATAL_ERROR "config_schema.h not found in SCHEMA_DIR (${SCHEMA_DIR}); run scripts/gen_schema.py")
endif()

find_package(PkgConfig REQUIRED)
pkg_check_modules(GLIB REQUIRED glib-2.0)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE MinSizeRel)
endif()
set(CMAKE_C_STANDARD 11)

#The TV has glib 2.72 while the toolchain's headers are newer, so flag anything newer
add_compile_definitions(
    GLIB_VERSION_MIN_REQUIRED=GLIB_VERSION_2_56
    GLIB_VERSION_MAX_ALLOWED=GLIB_VERSION_2_72
    _GNU_SOURCE)
add_compile_options(-Wall -Wextra)

set(COMMON_INCLUDES ${CMAKE_CURRENT_SOURCE_DIR}/src ${SCHEMA_DIR} ${GLIB_INCLUDE_DIRS})
#luna-service2 and pbnjson have no pkg-config files in the toolchain, so link them by name
set(COMMON_LIBS luna-service2 pbnjson_c ${GLIB_LIBRARIES} m)

add_executable(crosshair-service src/service.c src/config.c)
target_include_directories(crosshair-service PRIVATE ${COMMON_INCLUDES})
target_link_libraries(crosshair-service PRIVATE ${COMMON_LIBS})
target_link_options(crosshair-service PRIVATE -s)

add_executable(config-test test/config_test.c src/config.c)
target_include_directories(config-test PRIVATE ${COMMON_INCLUDES})
target_link_libraries(config-test PRIVATE pbnjson_c m)
